//! Whether the code protects a use of a feature that some target browser lacks. One model answers it;
//! the README lists its tables under "Rules for checks".
//!
//! - The flow: what the parents do with the value of the use in a browser without the feature. A bare
//!   global throws `ReferenceError` when it is read, except under `typeof`. A member reads as
//!   `undefined`, and each parent passes it on, drops it, throws on it, or lets it escape into a name,
//!   an argument or a return value. A value that passed `||`, `&&`, `??`, `?:` or `?.` is optional: the
//!   code expects that it may be missing, so its escape is no finding. A raw value that escapes into an
//!   alias goes on from every read of the alias (see `alias`).
//! - The facts: the features that a check proves present at the use. The branches of `if`, `?:`, `&&`,
//!   `||` and of loops, and the statements before the use that exit early, check features. A check of an
//!   alias checks its expression.
//!
//! A use that throws is no finding under a fact that covers it or inside a `try` with a `catch` in the
//! same function. A raw value that escapes is no finding under a fact that covers it. A fact covers a
//! use when it names the same path or, for a method, the same name, or when it names a feature that
//! every target version without full support of the use lacks too.
//!
//! The outcome of the flow and the facts are kept by node, so the uses of a file cost linear work.

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::rc::Rc;

use oxc_ast::AstKind;
use oxc_ast::ast::{
    AssignmentOperator, AssignmentTargetMaybeDefault, BinaryExpression, BinaryOperator, BindingPattern, Expression,
    LogicalExpression, LogicalOperator, Statement, UnaryOperator,
};
use oxc_semantic::{NodeId, Semantic, SymbolId};
use oxc_span::GetSpan;

use super::alias::{Alias, Aliases};
use super::globals::path_feature;
use super::path::{WINDOW_ALIASES, as_member, is_global, property};
use super::slot::{Slot, SpreadInto, is_boolean, is_boolean_argument, outermost, slot};
use super::{Key, Origin, Use};
use crate::data::FeatureId;
use crate::targets::Targets;

/// The state of the value on the way from the use to the root.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum Flow {
    /// It passed `||`, `&&`, `??`, `?:` or `?.`: the code expects that it may be missing.
    Optional,
    /// The value as it is.
    Raw,
}

/// The end of the flow. The order is the severity: when an assignment both passes the value on and
/// stores it, the worse outcome counts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Outcome {
    Safe,
    Escapes(Flow),
    Throws,
}

/// A key that a check proves present, interned. The key of a use is interned the same way, so a fact
/// covers the use with the same key by equality.
type Fact = u32;

/// A use that the facts are asked about: its key and its feature.
#[derive(Clone, Copy)]
struct Subject {
    fact: Fact,
    feature: FeatureId,
}

/// The facts that hold where a check has a value. They do not depend on the use, so one answer serves
/// every use under the check.
#[derive(Clone)]
enum Facts {
    /// The check never has the value, so the code there never runs: every fact holds.
    All,
    /// Sorted facts and the features that they name.
    Set(Rc<FactSet>),
    /// The facts of the operands `start..end` of an `&&` chain that is true or an `||` chain that is
    /// false: the index of the chain answers for every part of it.
    Range { index: usize, start: usize, end: usize },
}

#[derive(Default)]
struct FactSet {
    facts: Vec<Fact>,
    features: Vec<FeatureId>,
}

/// The facts of a sequence by position: the operands of a chain or the statements of a list. A query
/// asks whether a position in a range proves the subject. Flat sorted pairs keep the build to a few
/// allocations per sequence, and every query costs a binary search or the size of its answer.
#[derive(Default)]
struct Index {
    /// `(fact, position)`, sorted: whether a fact holds in a range.
    facts: Vec<(Fact, usize)>,
    /// `(position, fact)` and `(position, feature)` in the order of positions: the facts of a range.
    by_position: Vec<(usize, Fact)>,
    features: Vec<(usize, FeatureId)>,
    /// Each feature that the facts name, once, with its positions in order. A use asks only the features
    /// that imply its own, so it does not read every position of the sequence.
    named: Vec<(FeatureId, Vec<usize>)>,
    /// For a statement list: the number of statements, and its nested blocks with their own indexes.
    len: usize,
    nested: Vec<(usize, usize)>,
}

impl Index {
    /// Adds the facts of the position `at`. Positions come in increasing order.
    fn add(&mut self, at: usize, all: bool, facts: &[Fact], features: &[FeatureId]) {
        if all {
            self.by_position.push((at, ALL));
        }
        self.by_position.extend(facts.iter().map(|&fact| (at, fact)));
        self.features.extend(features.iter().map(|&feature| (at, feature)));
    }

    fn finish(mut self) -> Self {
        count!(guards, self.by_position.len() + self.features.len());
        self.facts = self.by_position.iter().map(|&(at, fact)| (fact, at)).collect();
        self.facts.sort_unstable();
        self.facts.dedup();
        let mut named: Vec<(FeatureId, usize)> = self.features.iter().map(|&(at, feature)| (feature, at)).collect();
        named.sort_unstable_by_key(|&(feature, at)| (feature.index(), at));
        for (feature, at) in named {
            match self.named.last_mut() {
                Some((last, positions)) if *last == feature => positions.push(at),
                _ => self.named.push((feature, vec![at])),
            }
        }
        self
    }

    fn holds(&self, fact: Fact, start: usize, end: usize) -> bool {
        let first = self.facts.partition_point(|&entry| entry < (fact, start));
        self.facts
            .get(first)
            .is_some_and(|&(found, at)| found == fact && at < end)
    }

    /// The facts and the features of the positions `start..end`, sorted.
    fn range(&self, start: usize, end: usize) -> (Vec<Fact>, Vec<FeatureId>) {
        let facts_at = slice(&self.by_position, start, end);
        let features_at = slice(&self.features, start, end);
        count!(guards, facts_at.len() + features_at.len() + 1);
        let mut facts: Vec<Fact> = facts_at
            .iter()
            .map(|&(_, fact)| fact)
            .filter(|&fact| fact != ALL)
            .collect();
        facts.sort_unstable();
        facts.dedup();
        let mut features: Vec<FeatureId> = features_at.iter().map(|&(_, feature)| feature).collect();
        features.sort_unstable_by_key(|feature| feature.index());
        features.dedup();
        (facts, features)
    }
}

/// The entries of the positions `start..end` in a list in the order of positions. Finding them costs
/// two binary searches; a caller counts the entries that it reads.
fn slice<T>(entries: &[(usize, T)], start: usize, end: usize) -> &[(usize, T)] {
    let first = entries.partition_point(|&(at, _)| at < start);
    let last = entries.partition_point(|&(at, _)| at < end);
    &entries[first..last.max(first)]
}

/// The fact of `Facts::All` in an index: a position where every fact holds.
const ALL: Fact = Fact::MAX;

/// Whether a sorted list of positions has one in `start..end`.
fn within(positions: &[usize], start: usize, end: usize) -> bool {
    let first = positions.partition_point(|&position| position < start);
    positions.get(first).is_some_and(|&position| position < end)
}

/// The question of a climb that asks for a `try`, beside the subjects that ask for facts.
const CAUGHT: usize = usize::MAX;

/// A step of the flow from a node with a flow.
enum Step {
    /// To the parent, with this flow.
    Up(Flow),
    /// To the parent with the same flow, and an escape of the value into the target of an assignment.
    Fork,
    /// To the parent with the same flow, and the raw value into an alias that the assignment writes.
    ForkInto(SymbolId),
    /// To the optional chain around the parent, with `Flow::Optional`.
    Chain,
    /// The raw value goes into the alias that the declaration declares.
    Into(SymbolId),
    Done(Outcome),
}

/// What a step of the flow does with the value besides passing it on.
#[derive(Clone, Copy)]
enum Store {
    None,
    /// The value escapes into the target of an assignment.
    Escape,
    /// The raw value goes into an alias.
    Alias(SymbolId),
}

/// The aliases that a raw value goes into, as a list. The flows of the nodes below an alias share the
/// list above it, so a chain of `a = b = … = X` costs one entry per alias.
struct Stored {
    alias: SymbolId,
    next: Option<Rc<Stored>>,
}

/// The end of the flow of a value: the outcome where it ends, and the aliases that the raw value goes
/// into on the way. The flow goes on from every read of each alias.
type End = (Outcome, Option<Rc<Stored>>);

/// How deep the guards follow a use into aliases of aliases. Each level is a recursion through
/// `is_followed` and `flow`, so the limit keeps the stack small. Code has one or two levels: a `const` of
/// a `const`, the temporary variable of a downleveled `?.`. The answers are kept by alias, so the limit
/// costs no work per use. Deeper, the value escapes, and the use is a finding. The facts of a check
/// resolve aliases at any depth without recursion (`resolve_alias`).
const ALIAS_DEPTH: usize = 16;

/// The names of members that a check through an alias proves, nearest to the alias first. A check of an
/// alias asks the facts of its expression each time, and the limit keeps that constant.
const ALIAS_NAMES: usize = 4;

/// What a check of an expression proves present: the head of its path and the names of its members.
#[derive(Clone, Default)]
struct Resolved<'a> {
    /// `None` when the root is not a global reference or a key is not static.
    head: Option<Head<'a>>,
    /// The names of the members on the way, from the end of the expression to its root.
    names: Vec<&'a str>,
}

/// The first two segments of a path without the leading aliases of the global object. The key of a use
/// has one or two segments, so a longer prefix covers none.
#[derive(Clone)]
struct Head<'a> {
    segments: Vec<&'a str>,
    /// The path is only aliases of the global object, such as `window.self`; `segments` holds the last.
    aliases: bool,
}

impl<'a> Head<'a> {
    fn global(name: &'a str) -> Self {
        Self {
            segments: vec![name],
            aliases: WINDOW_ALIASES.contains(&name),
        }
    }

    /// The head of the path with the segments `more` after it, in order.
    fn extend(&self, more: &[&'a str]) -> Self {
        if more.is_empty() {
            return self.clone();
        }
        if self.aliases {
            // The leading aliases of `more` are dropped too, but the last segment stays.
            let skip = more
                .iter()
                .take_while(|segment| WINDOW_ALIASES.contains(segment))
                .count()
                .min(more.len() - 1);
            let rest = &more[skip..];
            return Self {
                segments: rest.iter().take(2).copied().collect(),
                aliases: rest.len() == 1 && WINDOW_ALIASES.contains(&rest[0]),
            };
        }
        let mut segments = self.segments.clone();
        segments.extend(more.iter().take(2 - segments.len()));
        Self {
            segments,
            aliases: false,
        }
    }
}

/// An expression walked from its end to its root.
struct Walk<'a> {
    /// The segments from the end to the root.
    segments: Vec<&'a str>,
    names: Vec<&'a str>,
    /// Every key on the way is static.
    complete: bool,
}

/// The root of a walk.
enum Root<'a> {
    Global(&'a str),
    Alias(SymbolId),
    Other,
}

/// Answers for the uses of one file. The answers are kept by node, so uses with common ancestors share
/// the work.
pub struct Guards<'s, 'a> {
    semantic: &'s Semantic<'a>,
    targets: &'s Targets,
    /// The outcome of the flow from a node with a flow.
    flows: HashMap<(NodeId, Flow), Outcome>,
    /// The aliases that the raw value goes into on the flow from a node with a flow, when there are any.
    stores: HashMap<(NodeId, Flow), Rc<Stored>>,
    aliases: Aliases<'s, 'a>,
    /// Whether every read of an alias is guarded, by alias and subject. `None` is a use without a key.
    followed: HashMap<(SymbolId, Option<usize>), bool>,
    /// The aliases of aliases that the current question follows.
    depth: usize,
    /// What a check of the expression of an alias proves, by the node of the expression.
    resolved: HashMap<NodeId, Rc<Resolved<'a>>>,
    /// Interned keys and the features that they name.
    facts: HashMap<Key<'a>, Fact>,
    fact_features: Vec<Option<FeatureId>>,
    subjects: Vec<Subject>,
    subject_ids: HashMap<(Fact, FeatureId), usize>,
    /// The answers of the climbs by node and question: whether the facts at the node cover a subject,
    /// and with `CAUGHT`, whether a `try` catches what the node throws.
    answers: HashMap<(NodeId, usize), bool>,
    /// `F(T, p)` by test node and value.
    tests: HashMap<(NodeId, bool), Facts>,
    /// Whether a block or an `if` always exits.
    exits: HashMap<NodeId, bool>,
    /// For a list index and a subject: the positions of the nested blocks that cover the subject.
    nested: HashMap<(usize, usize), Vec<usize>>,
    /// The indexes of chains and of statement lists.
    indexes: Vec<Index>,
    /// For each statement list: its index.
    lists: HashMap<NodeId, usize>,
    /// For an index and the feature of a use: the work spent on the ranges, or the entries of
    /// `Index::named` that imply the feature.
    implying: HashMap<(usize, FeatureId), Implying>,
    /// `Targets::first_supports` by checked feature: one entry per checked feature of the file, not
    /// per pair with the feature of a use.
    first_supports: HashMap<FeatureId, Box<[u32]>>,
}

/// What an index knows about the checked features that imply the feature of a use.
enum Implying {
    /// The queries so far read the entries of their ranges, this many in total.
    Scanned(usize),
    /// The entries of `Index::named` that imply the feature.
    Found(Box<[usize]>),
}

impl<'s, 'a> Guards<'s, 'a> {
    pub fn new(semantic: &'s Semantic<'a>, targets: &'s Targets) -> Self {
        Self {
            semantic,
            targets,
            flows: HashMap::new(),
            stores: HashMap::new(),
            aliases: Aliases::new(semantic),
            followed: HashMap::new(),
            depth: 0,
            resolved: HashMap::new(),
            facts: HashMap::new(),
            fact_features: Vec::new(),
            subjects: Vec::new(),
            subject_ids: HashMap::new(),
            answers: HashMap::new(),
            tests: HashMap::new(),
            exits: HashMap::new(),
            nested: HashMap::new(),
            indexes: Vec::new(),
            lists: HashMap::new(),
            implying: HashMap::new(),
            first_supports: HashMap::new(),
        }
    }

    pub fn is_guarded(&mut self, usage: &Use<'a>) -> bool {
        let Some((outcome, stores)) = self.outcome(usage) else {
            return false;
        };
        if matches!(outcome, Outcome::Safe | Outcome::Escapes(Flow::Optional)) && stores.is_none() {
            return true;
        }
        let subject = self.subject(usage.key.clone(), usage.feature);
        self.decide(usage.node, outcome, subject) && self.are_followed(stores, subject)
    }

    /// Whether every read of every alias in the list is guarded for the subject.
    fn are_followed(&mut self, stores: Option<Rc<Stored>>, subject: Option<usize>) -> bool {
        let mut next = stores;
        while let Some(stored) = next {
            count!(guards);
            if !self.is_followed(stored.alias, subject) {
                return false;
            }
            next = stored.next.clone();
        }
        true
    }

    /// Whether the end of a flow at `node` is guarded for the subject.
    fn decide(&mut self, node: NodeId, outcome: Outcome, subject: Option<usize>) -> bool {
        match outcome {
            Outcome::Safe | Outcome::Escapes(Flow::Optional) => true,
            Outcome::Escapes(Flow::Raw) => subject.is_some_and(|subject| self.is_covered(node, subject)),
            Outcome::Throws => subject.is_some_and(|subject| self.is_covered(node, subject)) || self.is_caught(node),
        }
    }

    /// `None` for syntax: the file does not parse, so nothing protects it.
    fn outcome(&mut self, usage: &Use<'_>) -> Option<End> {
        let nodes = self.semantic.nodes();
        Some(match usage.origin {
            Origin::Parse => return None,
            Origin::Call => (Outcome::Throws, None),
            Origin::Global if slot(nodes, outermost(nodes, usage.node)) == Slot::Typeof => (Outcome::Safe, None),
            Origin::Global => (Outcome::Throws, None),
            Origin::Member | Origin::Method => match nodes.kind(usage.node) {
                AstKind::StaticMemberExpression(_) | AstKind::ComputedMemberExpression(_) => self.flow(usage.node),
                // A default value replaces a missing property, as `??` does.
                kind if has_default(kind) => (Outcome::Safe, None),
                // A destructured property is bound to a name, and the value goes on from the reads of an alias.
                AstKind::BindingProperty(property) if let Some(alias) = self.aliases.bound_by(&property.value) => {
                    (Outcome::Safe, Some(Rc::new(Stored { alias, next: None })))
                }
                _ => (Outcome::Escapes(Flow::Raw), None),
            },
        })
    }

    /// Whether every read of the alias is guarded for the subject: the raw value of a use goes on from each.
    fn is_followed(&mut self, alias: SymbolId, subject: Option<usize>) -> bool {
        if let Some(&known) = self.followed.get(&(alias, subject)) {
            return known;
        }
        if self.depth >= ALIAS_DEPTH {
            return false;
        }
        // An alias that holds itself, `t = t`, holds no other value.
        self.followed.insert((alias, subject), true);
        self.depth += 1;
        let mut guarded = true;
        for read in self.aliases.reads(alias) {
            count!(guards);
            let (outcome, stores) = self.flow(read);
            guarded = self.decide(read, outcome, subject) && self.are_followed(stores, subject);
            if !guarded {
                break;
            }
        }
        self.depth -= 1;
        self.followed.insert((alias, subject), guarded);
        guarded
    }

    /// Table 1: the climb from the node `start`, a member read or a read of an alias, to the end of its
    /// flow.
    fn flow(&mut self, start: NodeId) -> End {
        let semantic = self.semantic;
        let nodes = semantic.nodes();
        let mut visited = Vec::new();
        let (mut id, mut flow) = (start, Flow::Raw);
        let mut stores = None;
        let mut outcome = loop {
            if let Some(&known) = self.flows.get(&(id, flow)) {
                stores = self.stores.get(&(id, flow)).cloned();
                break known;
            }
            count!(climb);
            let step = match slot(nodes, id) {
                Slot::Wrapper | Slot::SeqLast | Slot::Await => Step::Up(flow),
                Slot::LogicalLeft(LogicalOperator::And)
                | Slot::LogicalRight(_)
                | Slot::CondConsequent
                | Slot::CondAlternate => Step::Up(Flow::Optional),
                Slot::AssignValue => match flow {
                    Flow::Raw => self.aliases.stored_into(id).map_or(Step::Fork, Step::ForkInto),
                    Flow::Optional => Step::Fork,
                },
                Slot::Object { optional: true } | Slot::Callee { optional: true } => Step::Chain,
                Slot::Object { .. }
                | Slot::Callee { .. }
                | Slot::NewCallee
                | Slot::Tag
                | Slot::InstanceofRight
                | Slot::InRight
                | Slot::Spread {
                    into: SpreadInto::Array | SpreadInto::Call,
                }
                | Slot::ForOfRight
                | Slot::DestructuringSource
                | Slot::Yield { delegate: true }
                | Slot::Extends => Step::Done(Outcome::Throws),
                Slot::SeqDiscard
                | Slot::LogicalLeft(_)
                | Slot::CondTest
                | Slot::Test
                | Slot::Not
                | Slot::Typeof
                | Slot::Void
                | Slot::Delete
                | Slot::Compare
                | Slot::InstanceofLeft
                | Slot::Spread {
                    into: SpreadInto::Object,
                }
                | Slot::ForInRight
                | Slot::AssignTarget
                | Slot::Statement => Step::Done(Outcome::Safe),
                Slot::Argument if is_boolean_argument(semantic, id) => Step::Done(Outcome::Safe),
                // A branch of `if` and the body of a loop hold statements, so no flow reaches them.
                Slot::Argument
                | Slot::Yield { delegate: false }
                | Slot::IfConsequent
                | Slot::IfAlternate
                | Slot::LoopBody => Step::Done(Outcome::Escapes(flow)),
                Slot::Other => match flow {
                    Flow::Raw => self
                        .aliases
                        .stored_into(id)
                        .map_or(Step::Done(Outcome::Escapes(flow)), Step::Into),
                    Flow::Optional => Step::Done(Outcome::Escapes(flow)),
                },
            };
            let store = match step {
                Step::Fork => Store::Escape,
                Step::ForkInto(alias) | Step::Into(alias) => Store::Alias(alias),
                _ => Store::None,
            };
            visited.push((id, flow, store));
            match step {
                Step::Done(outcome) => break outcome,
                Step::Into(_) => break Outcome::Safe,
                Step::Up(next) => {
                    id = nodes.parent_id(id);
                    flow = next;
                }
                Step::Fork | Step::ForkInto(_) => id = nodes.parent_id(id),
                Step::Chain => {
                    id = nodes.parent_id(id);
                    while !matches!(nodes.kind(id), AstKind::ChainExpression(_)) {
                        count!(climb);
                        id = nodes.parent_id(id);
                    }
                    flow = Flow::Optional;
                }
            }
        };
        for (id, flow, store) in visited.into_iter().rev() {
            match store {
                Store::None => {}
                Store::Escape => outcome = outcome.max(Outcome::Escapes(flow)),
                Store::Alias(alias) => {
                    count!(guards);
                    stores = Some(Rc::new(Stored { alias, next: stores }));
                }
            }
            self.flows.insert((id, flow), outcome);
            if let Some(stores) = &stores {
                self.stores.insert((id, flow), stores.clone());
            }
        }
        (outcome, stores)
    }

    /// A `try` with a `catch` around the node in the same function: it catches what the node throws.
    fn is_caught(&mut self, node: NodeId) -> bool {
        self.climb(node, CAUGHT, |guards, parent, child, _| {
            let nodes = guards.semantic.nodes();
            let child_span = nodes.kind(child).span();
            match nodes.kind(parent) {
                AstKind::TryStatement(statement) => {
                    (statement.handler.is_some() && statement.block.span == child_span).then_some(true)
                }
                // A callback runs after the `try` has finished, and so does the value of an instance field:
                // the class runs it when it makes an object. Static values, keys and decorators run with
                // the class, inside the `try`.
                AstKind::Function(_) | AstKind::ArrowFunctionExpression(_) => Some(false),
                AstKind::PropertyDefinition(field)
                    if !field.r#static && field.value.as_ref().is_some_and(|value| value.span() == child_span) =>
                {
                    Some(false)
                }
                AstKind::AccessorProperty(field)
                    if !field.r#static && field.value.as_ref().is_some_and(|value| value.span() == child_span) =>
                {
                    Some(false)
                }
                _ => None,
            }
        })
    }

    /// Climbs from `node` until `decide` answers the question at a parent, a node has a known answer, or
    /// the climb reaches the root. Every node on the way keeps the answer, so the next climb stops there.
    fn climb(
        &mut self,
        node: NodeId,
        question: usize,
        decide: impl Fn(&mut Self, NodeId, NodeId, usize) -> Option<bool>,
    ) -> bool {
        let nodes = self.semantic.nodes();
        let mut visited = Vec::new();
        let mut id = node;
        let answer = loop {
            if let Some(&known) = self.answers.get(&(id, question)) {
                break known;
            }
            let parent = nodes.parent_id(id);
            if parent == id {
                break false;
            }
            count!(climb);
            visited.push(id);
            if let Some(answer) = decide(self, parent, id, question) {
                break answer;
            }
            id = parent;
        };
        for id in visited {
            self.answers.insert((id, question), answer);
        }
        answer
    }

    /// The subject of a use: its key and its feature. `None` for a use without a key, which no check covers.
    fn subject(&mut self, key: Option<Key<'a>>, feature: FeatureId) -> Option<usize> {
        let fact = self.intern(key?);
        let next = self.subjects.len();
        let subject = *self.subject_ids.entry((fact, feature)).or_insert(next);
        if subject == next {
            self.subjects.push(Subject { fact, feature });
        }
        Some(subject)
    }

    /// Whether the facts at `node` cover the subject.
    fn is_covered(&mut self, node: NodeId, subject: usize) -> bool {
        self.climb(node, subject, |guards, parent, child, subject| {
            guards.facts_of(parent, child, subject).then_some(true)
        })
    }

    fn intern(&mut self, key: Key<'a>) -> Fact {
        let next = self.fact_features.len() as Fact;
        match self.facts.entry(key) {
            Entry::Occupied(entry) => *entry.get(),
            Entry::Vacant(entry) => {
                // A feature that no target lacks implies no other, so a check of it proves only its key.
                let feature = match entry.key() {
                    Key::Path(path) => path_feature(path),
                    Key::Method(_) => None,
                }
                .filter(|&feature| !self.targets.support(feature).missing.is_empty());
                self.fact_features.push(feature);
                entry.insert(next);
                next
            }
        }
    }

    /// Table 2: whether the parent proves the subject present in its child `child`.
    fn facts_of(&mut self, parent: NodeId, child: NodeId, subject: usize) -> bool {
        let nodes = self.semantic.nodes();
        let (test, value) = match (nodes.kind(parent), slot(nodes, child)) {
            (AstKind::IfStatement(statement), Slot::IfConsequent) => (&statement.test, true),
            (AstKind::IfStatement(statement), Slot::IfAlternate) => (&statement.test, false),
            (AstKind::ConditionalExpression(expression), Slot::CondConsequent) => (&expression.test, true),
            (AstKind::ConditionalExpression(expression), Slot::CondAlternate) => (&expression.test, false),
            (AstKind::WhileStatement(statement), Slot::LoopBody) => (&statement.test, true),
            (AstKind::ForStatement(statement), Slot::LoopBody) => match &statement.test {
                Some(test) => (test, true),
                None => return false,
            },
            (AstKind::LogicalExpression(logical), Slot::LogicalRight(LogicalOperator::And)) => (&logical.left, true),
            (AstKind::LogicalExpression(logical), Slot::LogicalRight(LogicalOperator::Or)) => (&logical.left, false),
            (AstKind::Program(program), _) => return self.list(parent, &program.body, child, subject),
            (AstKind::BlockStatement(block), _) => return self.list(parent, &block.body, child, subject),
            (AstKind::FunctionBody(body), _) => return self.list(parent, &body.statements, child, subject),
            (AstKind::StaticBlock(block), _) => return self.list(parent, &block.body, child, subject),
            (AstKind::SwitchCase(case), _) => return self.list(parent, &case.consequent, child, subject),
            _ => return false,
        };
        let facts = self.test(test, value);
        self.covers(&facts, subject)
    }

    /// `N(S)` of the statements before `child` in a statement list. The list gets an index once, so each
    /// use asks it instead of reading the statements again.
    fn list(&mut self, list: NodeId, statements: &'a [Statement<'a>], child: NodeId, subject: usize) -> bool {
        let index = self.list_index(list, statements);
        let child = self.semantic.nodes().kind(child).span();
        let position = statements.partition_point(|statement| statement.span().end <= child.start);
        self.covers(
            &Facts::Range {
                index,
                start: 0,
                end: position,
            },
            subject,
        )
    }

    /// The index of a statement list. A nested block `{ … }` keeps its own index, and the list refers to
    /// it: copying the facts of nested blocks into every list around them would grow with the depth.
    fn list_index(&mut self, list: NodeId, statements: &'a [Statement<'a>]) -> usize {
        if let Some(&index) = self.lists.get(&list) {
            return index;
        }
        let mut index = Index {
            len: statements.len(),
            ..Index::default()
        };
        for (at, statement) in statements.iter().enumerate() {
            count!(guards);
            if let Statement::BlockStatement(block) = statement {
                let nested = self.list_index(block.node_id(), &block.body);
                index.nested.push((at, nested));
                continue;
            }
            let facts = self.after(statement);
            let (all, facts, features) = self.expand(&facts);
            index.add(at, all, &facts, &features);
        }
        self.indexes.push(index.finish());
        self.lists.insert(list, self.indexes.len() - 1);
        self.indexes.len() - 1
    }

    /// `N(S)` of a statement other than a block: the facts after its normal end.
    fn after(&mut self, statement: &'a Statement<'a>) -> Facts {
        let Statement::IfStatement(check) = statement else {
            return Facts::Set(Rc::default());
        };
        let consequent = self.exits(&check.consequent);
        match &check.alternate {
            None if consequent => self.test(&check.test, false),
            Some(alternate) => match (consequent, self.exits(alternate)) {
                (false, true) => self.test(&check.test, true),
                (true, false) => self.test(&check.test, false),
                _ => Facts::Set(Rc::default()),
            },
            None => Facts::Set(Rc::default()),
        }
    }

    /// Whether a nested block in `start..end` of a list covers the subject after its end. The answer for
    /// each block of the list is kept by subject, so a deep nest costs its depth once per subject.
    fn nested_covers(&mut self, index: usize, start: usize, end: usize, subject: usize) -> bool {
        if self.indexes[index].nested.is_empty() {
            return false;
        }
        if !self.nested.contains_key(&(index, subject)) {
            let mut covering = Vec::new();
            for (at, nested) in self.indexes[index].nested.clone() {
                count!(guards);
                let range = Facts::Range {
                    index: nested,
                    start: 0,
                    end: self.indexes[nested].len,
                };
                if self.covers(&range, subject) {
                    covering.push(at);
                }
            }
            self.nested.insert((index, subject), covering);
        }
        within(&self.nested[&(index, subject)], start, end)
    }

    /// Whether the statement never ends normally: `return`, `throw`, `break`, `continue`, a block with such
    /// a statement, and an `if` whose branches both exit.
    fn exits(&mut self, statement: &'a Statement<'a>) -> bool {
        let id = statement.node_id();
        if let Some(&exits) = self.exits.get(&id) {
            return exits;
        }
        count!(guards);
        let exits = match statement {
            Statement::ReturnStatement(_)
            | Statement::ThrowStatement(_)
            | Statement::ContinueStatement(_)
            | Statement::BreakStatement(_) => return true,
            Statement::BlockStatement(block) => block.body.iter().any(|statement| self.exits(statement)),
            Statement::IfStatement(check) => match &check.alternate {
                Some(alternate) => self.exits(alternate) && self.exits(&check.consequent),
                None => false,
            },
            _ => return false,
        };
        // Only nested blocks and `if`s are asked again.
        self.exits.insert(id, exits);
        exits
    }

    /// `F(test, value)`, kept by node and value. Every part of a test goes through here too: a `?:` asks
    /// its test for both values, so without the memo nested tests would cost twice the work per level.
    fn test(&mut self, test: &'a Expression<'a>, value: bool) -> Facts {
        let key = (test.node_id(), value);
        if let Some(facts) = self.tests.get(&key) {
            return facts.clone();
        }
        let facts = self.compute(test, value);
        self.tests.insert(key, facts.clone());
        facts
    }

    /// Table 3: `F(test, value)`.
    fn compute(&mut self, test: &'a Expression<'a>, value: bool) -> Facts {
        count!(guards);
        let semantic = self.semantic;
        match test.get_inner_expression() {
            Expression::UnaryExpression(unary) if unary.operator == UnaryOperator::LogicalNot => {
                self.test(&unary.argument, !value)
            }
            Expression::SequenceExpression(sequence) if !sequence.expressions.is_empty() => {
                self.test(&sequence.expressions[sequence.expressions.len() - 1], value)
            }
            Expression::AssignmentExpression(assignment) if assignment.operator == AssignmentOperator::Assign => {
                self.test(&assignment.right, value)
            }
            Expression::CallExpression(call) if is_boolean(semantic, &call.callee) => match call.arguments.as_slice() {
                [argument] if let Some(argument) = argument.as_expression() => self.test(argument, value),
                _ => Facts::Set(Rc::default()),
            },
            // `A && B` is true when both are, `A || B` is false when both are: the facts of every operand.
            Expression::LogicalExpression(logical)
                if (logical.operator == LogicalOperator::And && value)
                    || (logical.operator == LogicalOperator::Or && !value) =>
            {
                match self.tests.get(&(logical.node_id(), value)) {
                    Some(facts) => facts.clone(),
                    None => self.chain(logical, value),
                }
            }
            // Otherwise one of the operands decides: the facts that every operand proves.
            Expression::LogicalExpression(logical) if logical.operator != LogicalOperator::Coalesce => {
                let mut facts = Facts::All;
                for operand in flatten(logical).0 {
                    let next = self.test(operand, value);
                    facts = self.intersect(&facts, &next);
                    if matches!(&facts, Facts::Set(set) if set.facts.is_empty() && set.features.is_empty()) {
                        break;
                    }
                }
                facts
            }
            Expression::ConditionalExpression(conditional) => {
                let (yes, then) = (
                    self.test(&conditional.test, true),
                    self.test(&conditional.consequent, value),
                );
                let (no, otherwise) = (
                    self.test(&conditional.test, false),
                    self.test(&conditional.alternate, value),
                );
                let (first, second) = (self.union(yes, then), self.union(no, otherwise));
                self.intersect(&first, &second)
            }
            leaf => match constant(semantic, leaf) {
                // A test that always has the other value never gets here.
                Some(truth) if truth != value => Facts::All,
                Some(_) => Facts::Set(Rc::default()),
                None => self.leaf(leaf, value),
            },
        }
    }

    /// The facts of a chain of one operator: an index of all its operands, built once for the whole
    /// chain. Every logical of the chain gets the range of its operands as its facts.
    fn chain(&mut self, logical: &'a LogicalExpression<'a>, value: bool) -> Facts {
        let nodes = self.semantic.nodes();
        // The outermost logical of the chain: parents with the same operator, through parentheses.
        let mut top = logical;
        let mut id = logical.node_id();
        loop {
            count!(guards);
            id = nodes.parent_id(id);
            match nodes.kind(id) {
                AstKind::ParenthesizedExpression(_) => {}
                AstKind::LogicalExpression(parent) if parent.operator == logical.operator => top = parent,
                _ => break,
            }
        }
        let (operands, ranges) = flatten(top);
        let mut index = Index::default();
        for (at, operand) in operands.into_iter().enumerate() {
            let facts = self.test(operand, value);
            let (all, facts, features) = self.expand(&facts);
            index.add(at, all, &facts, &features);
        }
        self.indexes.push(index.finish());
        let index = self.indexes.len() - 1;
        for (node, start, end) in ranges {
            self.tests.insert((node, value), Facts::Range { index, start, end });
        }
        self.tests[&(logical.node_id(), value)].clone()
    }

    /// The leaves of table 3: a path, `typeof`, a comparison with `undefined`, `in` and `instanceof`.
    fn leaf(&mut self, test: &'a Expression<'a>, value: bool) -> Facts {
        let value_of = |guards: &mut Self, expression: &'a Expression<'a>| guards.present(expression, None);
        let Expression::BinaryExpression(binary) = test else {
            return if value {
                value_of(self, test)
            } else {
                Facts::Set(Rc::default())
            };
        };
        let none = Facts::Set(Rc::default());
        match binary.operator {
            BinaryOperator::In if value => match binary.left.get_inner_expression() {
                Expression::StringLiteral(name) => self.present(&binary.right, Some(name.value.as_str())),
                _ => none,
            },
            BinaryOperator::Instanceof if value => value_of(self, &binary.left),
            BinaryOperator::LessThan | BinaryOperator::GreaterThan => match minified_typeof(binary, value) {
                Some(argument) => value_of(self, argument),
                None => none,
            },
            operator if operator.is_equality() => {
                // Whether the operands are equal when the test has the value.
                let equal = matches!(operator, BinaryOperator::Equality | BinaryOperator::StrictEquality) == value;
                let operand = match typeof_compared(binary) {
                    Some((argument, kind)) => {
                        let present = if equal {
                            kind == "function" || kind == "object"
                        } else {
                            kind == "undefined"
                        };
                        present.then_some(argument)
                    }
                    None => compared_with_undefined(self.semantic, binary).filter(|_| !equal),
                };
                match operand {
                    Some(operand) => value_of(self, operand),
                    None => none,
                }
            }
            _ => none,
        }
    }

    /// The facts of a present value `X`, or of `X.name` with `name`: the path and, for a member, the
    /// name of the method `#name`.
    ///
    /// A present path has present prefixes: where `navigator.share?.call` is present, `navigator.share`
    /// and `navigator` are too. So the facts hold the prefixes of the path and the name of every member.
    fn present(&mut self, value: &'a Expression<'a>, name: Option<&'a str>) -> Facts {
        let resolved = self.resolve(value, name);
        let mut set = FactSet::default();
        // A head has at most two segments.
        for end in 1..=resolved.head.as_ref().map_or(0, |head| head.segments.len()) {
            let segments = &resolved.head.as_ref().expect("a head with segments").segments;
            let fact = self.intern(Key::Path(segments[..end].to_vec()));
            set.facts.push(fact);
            set.features.extend(self.fact_features[fact as usize]);
        }
        for name in resolved.names {
            set.facts.push(self.intern(Key::Method(name)));
        }
        set.facts.sort_unstable();
        set.facts.dedup();
        set.features.sort_unstable_by_key(|feature| feature.index());
        set.features.dedup();
        Facts::Set(Rc::new(set))
    }

    /// What a check of `value`, or of `value.name` with `name`, proves present. The value of an assignment
    /// `(y = X)` is `X`, and an alias has the value of its expression.
    fn resolve(&mut self, value: &'a Expression<'a>, name: Option<&'a str>) -> Resolved<'a> {
        let (mut walk, root) = self.walk(value, name);
        let base = match root {
            Root::Global(name) => Rc::new(Resolved {
                head: Some(Head::global(name)),
                names: Vec::new(),
            }),
            Root::Other => Rc::default(),
            Root::Alias(alias) => match self.aliases.get(alias) {
                Some(Alias::Value(value)) => self.resolve_alias(value),
                Some(Alias::Member(object, member)) => {
                    walk.segments.push(member);
                    walk.names.push(member);
                    self.resolve_alias(object)
                }
                None => Rc::default(),
            },
        };
        combine(&base, walk)
    }

    /// What a check of the expression of an alias proves, kept by its node: every check of the alias asks
    /// it. An alias of an alias resolves its own expression first, without recursion, so a long chain
    /// of aliases costs its length once.
    fn resolve_alias(&mut self, value: &'a Expression<'a>) -> Rc<Resolved<'a>> {
        let mut pending = Vec::new();
        let mut current = value;
        let mut base = loop {
            let id = current.node_id();
            if let Some(known) = self.resolved.get(&id) {
                break known.clone();
            }
            // An alias that holds itself, `t = t`, resolves to nothing.
            self.resolved.insert(id, Rc::default());
            let (mut walk, root) = self.walk(current, None);
            let next = match root {
                Root::Global(name) => Err(Resolved {
                    head: Some(Head::global(name)),
                    names: Vec::new(),
                }),
                Root::Other => Err(Resolved::default()),
                Root::Alias(alias) => match self.aliases.get(alias) {
                    Some(Alias::Value(value)) => Ok(value),
                    Some(Alias::Member(object, member)) => {
                        walk.segments.push(member);
                        walk.names.push(member);
                        Ok(object)
                    }
                    None => Err(Resolved::default()),
                },
            };
            pending.push((id, walk));
            match next {
                Ok(value) => current = value,
                Err(resolved) => break Rc::new(resolved),
            }
        };
        while let Some((id, walk)) = pending.pop() {
            let mut resolved = combine(&base, walk);
            resolved.names.truncate(ALIAS_NAMES);
            base = Rc::new(resolved);
            self.resolved.insert(id, base.clone());
        }
        base
    }

    /// Walks `value`, or `value.name` with `name`, from its end to its root: a global reference, an alias
    /// or another expression. The value of an assignment `(y = X)` is `X`.
    fn walk(&mut self, value: &'a Expression<'a>, name: Option<&'a str>) -> (Walk<'a>, Root<'a>) {
        let semantic = self.semantic;
        let mut walk = Walk {
            segments: name.into_iter().collect(),
            names: name.into_iter().collect(),
            complete: true,
        };
        let mut current = value;
        let root = loop {
            count!(guards);
            match current.get_inner_expression() {
                Expression::Identifier(identifier) if is_global(semantic, identifier) => {
                    break Root::Global(identifier.name.as_str());
                }
                Expression::Identifier(identifier) => {
                    let symbol = semantic.scoping().get_reference(identifier.reference_id()).symbol_id();
                    break match symbol.filter(|&symbol| self.aliases.get(symbol).is_some()) {
                        Some(symbol) => Root::Alias(symbol),
                        None => Root::Other,
                    };
                }
                Expression::AssignmentExpression(assignment) if assignment.operator == AssignmentOperator::Assign => {
                    current = &assignment.right;
                }
                _ => {
                    let Some(member) = as_member(current) else {
                        break Root::Other;
                    };
                    match property(member) {
                        Some(member) => {
                            walk.segments.push(member);
                            walk.names.push(member);
                        }
                        None => walk.complete = false,
                    }
                    current = member.object();
                }
            }
        };
        (walk, root)
    }

    /// The facts as a list: every fact holds, the facts, and the features that they name. The range of
    /// a statement list leaves out its nested blocks; only chains, which have none, are expanded.
    fn expand(&self, facts: &Facts) -> (bool, Vec<Fact>, Vec<FeatureId>) {
        match facts {
            Facts::All => (true, Vec::new(), Vec::new()),
            Facts::Set(set) => (false, set.facts.clone(), set.features.clone()),
            &Facts::Range { index, start, end } => {
                let index = &self.indexes[index];
                if index.holds(ALL, start, end) {
                    return (true, Vec::new(), Vec::new());
                }
                let (facts, features) = index.range(start, end);
                (false, facts, features)
            }
        }
    }

    /// Whether every fact holds: `Facts::All`, or a range with a position where every fact holds.
    fn is_all(&self, facts: &Facts) -> bool {
        match facts {
            Facts::All => true,
            Facts::Set(_) => false,
            &Facts::Range { index, start, end } => self.indexes[index].holds(ALL, start, end),
        }
    }

    fn union(&self, first: Facts, second: Facts) -> Facts {
        let empty = |facts: &Facts| matches!(facts, Facts::Set(set) if set.facts.is_empty());
        if empty(&first) {
            return second;
        }
        if empty(&second) {
            return first;
        }
        if self.is_all(&first) || self.is_all(&second) {
            return Facts::All;
        }
        let (_, mut facts, mut features) = self.expand(&first);
        let (_, more, more_features) = self.expand(&second);
        facts.extend(more);
        facts.sort_unstable();
        facts.dedup();
        features.extend(more_features);
        features.sort_unstable_by_key(|feature| feature.index());
        features.dedup();
        Facts::Set(Rc::new(FactSet { facts, features }))
    }

    fn intersect(&self, first: &Facts, second: &Facts) -> Facts {
        if self.is_all(first) {
            return second.clone();
        }
        if self.is_all(second) {
            return first.clone();
        }
        let (_, facts, features) = self.expand(first);
        let (_, other, other_features) = self.expand(second);
        Facts::Set(Rc::new(FactSet {
            facts: facts
                .into_iter()
                .filter(|fact| other.binary_search(fact).is_ok())
                .collect(),
            features: features
                .into_iter()
                .filter(|feature| {
                    other_features
                        .binary_search_by_key(&feature.index(), |other| other.index())
                        .is_ok()
                })
                .collect(),
        }))
    }

    /// Whether the facts cover the subject: they hold its key, or they name a feature that every target
    /// version without full support of the subject lacks too.
    fn covers(&mut self, facts: &Facts, subject: usize) -> bool {
        let Subject { fact, feature } = self.subjects[subject];
        match facts {
            Facts::All => true,
            Facts::Set(set) => {
                set.facts.binary_search(&fact).is_ok()
                    || set.features.iter().any(|&checked| {
                        count!(guards);
                        implies(self.targets, &mut self.first_supports, checked, feature)
                    })
            }
            &Facts::Range { index, start, end } => {
                let found = &self.indexes[index];
                found.holds(ALL, start, end)
                    || found.holds(fact, start, end)
                    || self.nested_covers(index, start, end, subject)
                    || self.implied_within(index, start, end, feature)
            }
        }
    }

    /// Whether a position in `start..end` of the index names a feature that implies `feature`.
    ///
    /// A query reads the features of its range while that costs less than reading every feature of the
    /// index once. A use before the checks of a list has an empty range and costs nothing. When the
    /// reads of the queries for one feature reach the size of `Index::named`, the entries that imply the
    /// feature are found once, and later queries read only them. So a pair of an index and a feature
    /// costs at most twice the size of `Index::named` before its queries get cheap.
    ///
    /// Answers are not kept by pairs of features: a map of them took a gigabyte on a file with thousands
    /// of distinct uses and checks. `implies` keeps only what it reads of each checked feature.
    fn implied_within(&mut self, index: usize, start: usize, end: usize, feature: FeatureId) -> bool {
        let targets = self.targets;
        let found = &self.indexes[index];
        let scanned = match self.implying.get(&(index, feature)) {
            Some(Implying::Found(implying)) => {
                return implying.iter().any(|&entry| {
                    count!(guards);
                    within(&found.named[entry].1, start, end)
                });
            }
            Some(&Implying::Scanned(scanned)) => scanned,
            None => 0,
        };
        let range = slice(&found.features, start, end);
        if range.is_empty() {
            return false;
        }
        if scanned + range.len() <= found.named.len() {
            self.implying
                .insert((index, feature), Implying::Scanned(scanned + range.len()));
            return range.iter().any(|&(_, checked)| {
                count!(guards);
                implies(targets, &mut self.first_supports, checked, feature)
            });
        }
        let implying: Box<[usize]> = found
            .named
            .iter()
            .enumerate()
            .filter(|&(_, &(checked, _))| {
                count!(guards);
                implies(targets, &mut self.first_supports, checked, feature)
            })
            .map(|(entry, _)| entry)
            .collect();
        count!(guards, implying.len());
        let answer = implying.iter().any(|&entry| {
            count!(guards);
            within(&found.named[entry].1, start, end)
        });
        self.implying.insert((index, feature), Implying::Found(implying));
        answer
    }
}

/// What a check of the walked expression proves, with `base` for its root.
fn combine<'a>(base: &Resolved<'a>, walk: Walk<'a>) -> Resolved<'a> {
    count!(guards, base.names.len());
    let head = match &base.head {
        Some(head) if walk.complete => {
            let segments: Vec<&'a str> = walk.segments.iter().rev().copied().collect();
            Some(head.extend(&segments))
        }
        _ => None,
    };
    let mut names = walk.names;
    names.extend(base.names.iter().copied());
    Resolved { head, names }
}

/// `Targets::implies` with the versions of the checked feature kept by the file.
fn implies(
    targets: &Targets,
    first_supports: &mut HashMap<FeatureId, Box<[u32]>>,
    checked: FeatureId,
    feature: FeatureId,
) -> bool {
    targets.implies_by(checked, feature, || {
        &**first_supports
            .entry(checked)
            .or_insert_with(|| targets.first_supports(checked))
    })
}

/// The operands of a chain of one operator, in order (`a`, `b`, `c` of `a && (b && c)`), and for every
/// logical of the chain the range of its operands. A stack instead of recursion: a chain of thousands
/// of operands is as deep as it is long.
#[allow(clippy::type_complexity)]
fn flatten<'b, 'a>(logical: &'b LogicalExpression<'a>) -> (Vec<&'b Expression<'a>>, Vec<(NodeId, usize, usize)>) {
    enum Step<'b, 'a> {
        Visit(&'b Expression<'a>),
        Close(NodeId, usize),
    }
    let mut operands = Vec::new();
    let mut ranges = Vec::new();
    let mut steps = vec![
        Step::Close(logical.node_id(), 0),
        Step::Visit(&logical.right),
        Step::Visit(&logical.left),
    ];
    while let Some(step) = steps.pop() {
        count!(guards);
        match step {
            Step::Visit(expression) => match expression.get_inner_expression() {
                Expression::LogicalExpression(inner) if inner.operator == logical.operator => {
                    steps.push(Step::Close(inner.node_id(), operands.len()));
                    steps.push(Step::Visit(&inner.right));
                    steps.push(Step::Visit(&inner.left));
                }
                _ => operands.push(expression),
            },
            Step::Close(node, start) => ranges.push((node, start, operands.len())),
        }
    }
    (operands, ranges)
}

/// A destructured property with a default value: `{ a = d }`, `{ a: b = d }`.
fn has_default(kind: AstKind<'_>) -> bool {
    match kind {
        AstKind::BindingProperty(property) => matches!(property.value, BindingPattern::AssignmentPattern(_)),
        AstKind::AssignmentTargetPropertyIdentifier(property) => property.init.is_some(),
        AstKind::AssignmentTargetPropertyProperty(property) => {
            matches!(
                property.binding,
                AssignmentTargetMaybeDefault::AssignmentTargetWithDefault(_)
            )
        }
        _ => false,
    }
}

/// The truth of a test that has one value: `void 0`, `undefined`, `null`, `false`, `0`, `""` are false;
/// `true`, other numbers and other strings are true.
fn constant(semantic: &Semantic<'_>, test: &Expression<'_>) -> Option<bool> {
    match test {
        Expression::BooleanLiteral(literal) => Some(literal.value),
        Expression::NullLiteral(_) => Some(false),
        Expression::NumericLiteral(literal) => Some(literal.value != 0.0 && !literal.value.is_nan()),
        Expression::StringLiteral(literal) => Some(!literal.value.is_empty()),
        Expression::UnaryExpression(unary) if unary.operator == UnaryOperator::Void => Some(false),
        Expression::Identifier(identifier) if identifier.name == "undefined" && is_global(semantic, identifier) => {
            Some(false)
        }
        _ => None,
    }
}

/// The key of a use as text, `navigator.share` or `#toSorted`, for the tests of the detectors.
#[cfg(test)]
pub(crate) fn key_text(usage: &Use<'_>) -> Option<String> {
    match usage.key.as_ref()? {
        Key::Path(path) => Some(path.join(".")),
        Key::Method(name) => Some(format!("#{name}")),
    }
}

/// `X` and the string in `typeof X === 'kind'`, in either order.
fn typeof_compared<'b, 'a>(binary: &'b BinaryExpression<'a>) -> Option<(&'b Expression<'a>, &'a str)> {
    match (binary.left.get_inner_expression(), binary.right.get_inner_expression()) {
        (Expression::UnaryExpression(unary), Expression::StringLiteral(literal))
        | (Expression::StringLiteral(literal), Expression::UnaryExpression(unary))
            if unary.operator == UnaryOperator::Typeof =>
        {
            Some((&unary.argument, literal.value.as_str()))
        }
        _ => None,
    }
}

/// esbuild writes `typeof X !== "undefined"` as `typeof X < "u"`, and `typeof X === "undefined"` as
/// `typeof X > "u"`. `X` when the test with the value means that `X` is present.
fn minified_typeof<'b, 'a>(binary: &'b BinaryExpression<'a>, value: bool) -> Option<&'b Expression<'a>> {
    let is_u = |expression: &Expression<'_>| matches!(expression.get_inner_expression(), Expression::StringLiteral(literal) if literal.value == "u");
    // `typeof X < "u"` and `"u" > typeof X` mean present; `typeof X > "u"` and `"u" < typeof X` mean missing.
    let (operand, operand_is_left) = if is_u(&binary.right) {
        (&binary.left, true)
    } else if is_u(&binary.left) {
        (&binary.right, false)
    } else {
        return None;
    };
    let means_present = (binary.operator == BinaryOperator::LessThan) == operand_is_left;
    match operand.get_inner_expression() {
        Expression::UnaryExpression(unary) if unary.operator == UnaryOperator::Typeof && means_present == value => {
            Some(&unary.argument)
        }
        _ => None,
    }
}

/// The operand that `binary` compares with `undefined`, `void 0` or, with `==` and `!=`, with `null`.
/// `undefined == null`, but `undefined !== null`.
fn compared_with_undefined<'b, 'a>(
    semantic: &Semantic<'_>,
    binary: &'b BinaryExpression<'a>,
) -> Option<&'b Expression<'a>> {
    let loose = matches!(binary.operator, BinaryOperator::Equality | BinaryOperator::Inequality);
    let is_undefined = |expression: &Expression<'_>| match expression.get_inner_expression() {
        Expression::NullLiteral(_) => loose,
        Expression::UnaryExpression(unary) => unary.operator == UnaryOperator::Void,
        Expression::Identifier(identifier) => identifier.name == "undefined" && is_global(semantic, identifier),
        _ => false,
    };
    if is_undefined(&binary.right) {
        Some(&binary.left)
    } else if is_undefined(&binary.left) {
        Some(&binary.right)
    } else {
        None
    }
}

//! Whether the code protects a use of a feature that some target browser lacks. One model answers it;
//! the README lists its tables under "Rules for checks".
//!
//! - The flow: what the parents do with the value of the use in a browser without the feature. A bare
//!   global throws `ReferenceError` when it is read, except under `typeof`. A member reads as
//!   `undefined`, and each parent passes it on, drops it, throws on it, or lets it escape into a name,
//!   an argument or a return value. A value that passed `||`, `&&`, `??`, `?:` or `?.` is optional: the
//!   code expects that it may be missing, so its escape is no finding.
//! - The facts: the features that a check proves present at the use. The branches of `if`, `?:`, `&&`,
//!   `||` and of loops, and the statements before the use that exit early, check features.
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
    AssignmentOperator, BinaryExpression, BinaryOperator, Expression, LogicalExpression, LogicalOperator, Statement,
    UnaryOperator,
};
use oxc_semantic::{NodeId, Semantic};
use oxc_span::{GetSpan, Span};

use super::globals::path_feature;
use super::path::{as_member, is_global, key_name, member_path, path, property};
use super::slot::{Slot, SpreadInto, destructured_source, is_boolean, is_boolean_argument, outermost, slot};
use super::{Origin, Use};
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

/// The name under which a check proves a feature present.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Key<'a> {
    /// `["navigator", "share"]`, without the aliases of the global object.
    Path(Vec<&'a str>),
    /// The name of a method of any object: a check of `a.toSorted` proves `b.toSorted` too.
    Method(&'a str),
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
/// asks whether a position in a range proves the subject. Flat sorted pairs keep the build to one
/// allocation per sequence.
#[derive(Default)]
struct Index {
    /// `(fact, position)`, sorted.
    facts: Vec<(Fact, usize)>,
    /// `(feature, position)`, sorted.
    features: Vec<(FeatureId, usize)>,
    /// For a statement list: the number of statements, and its nested blocks with their own indexes.
    len: usize,
    nested: Vec<(usize, usize)>,
}

impl Index {
    /// Adds the facts of the position `at`. Positions come in increasing order.
    fn add(&mut self, at: usize, all: bool, facts: &[Fact], features: &[FeatureId]) {
        if all {
            self.facts.push((ALL, at));
        }
        self.facts.extend(facts.iter().map(|&fact| (fact, at)));
        self.features.extend(features.iter().map(|&feature| (feature, at)));
    }

    fn finish(mut self) -> Self {
        self.facts.sort_unstable();
        self.facts.dedup();
        self.features
            .sort_unstable_by_key(|&(feature, at)| (feature.index(), at));
        self.features.dedup();
        self
    }

    fn holds(&self, fact: Fact, start: usize, end: usize) -> bool {
        let first = self.facts.partition_point(|&entry| entry < (fact, start));
        self.facts
            .get(first)
            .is_some_and(|&(found, at)| found == fact && at < end)
    }

    /// The facts and the features of the positions `start..end`.
    fn range(&self, start: usize, end: usize) -> (Vec<Fact>, Vec<FeatureId>) {
        let mut facts: Vec<Fact> = self
            .facts
            .iter()
            .filter(|&&(fact, at)| fact != ALL && (start..end).contains(&at))
            .map(|&(fact, _)| fact)
            .collect();
        facts.dedup();
        (facts, self.features(start, end))
    }

    /// The features of the positions `start..end`. Few facts name a feature, so this list is short.
    fn features(&self, start: usize, end: usize) -> Vec<FeatureId> {
        let mut features: Vec<FeatureId> = self
            .features
            .iter()
            .filter(|&&(_, at)| (start..end).contains(&at))
            .map(|&(feature, _)| feature)
            .collect();
        features.dedup();
        features
    }
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
    /// To the optional chain around the parent, with `Flow::Optional`.
    Chain,
    Done(Outcome),
}

/// Answers for the uses of one file. The answers are kept by node, so uses with common ancestors share
/// the work.
pub struct Guards<'s, 'a> {
    semantic: &'s Semantic<'a>,
    targets: &'s Targets,
    /// The outcome of the flow from a node with a flow.
    flows: HashMap<(NodeId, Flow), Outcome>,
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
    /// `Targets::implies` by the checked feature and the feature of the use.
    implied: HashMap<(FeatureId, FeatureId), bool>,
}

impl<'s, 'a> Guards<'s, 'a> {
    pub fn new(semantic: &'s Semantic<'a>, targets: &'s Targets) -> Self {
        Self {
            semantic,
            targets,
            flows: HashMap::new(),
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
            implied: HashMap::new(),
        }
    }

    pub fn is_guarded(&mut self, usage: &Use) -> bool {
        match self.outcome(usage) {
            None => false,
            Some(Outcome::Safe | Outcome::Escapes(Flow::Optional)) => true,
            Some(Outcome::Escapes(Flow::Raw)) => self.is_covered(usage),
            Some(Outcome::Throws) => self.is_covered(usage) || self.is_caught(usage.node),
        }
    }

    /// `None` for syntax: the file does not parse, so nothing protects it.
    fn outcome(&mut self, usage: &Use) -> Option<Outcome> {
        let nodes = self.semantic.nodes();
        Some(match usage.origin {
            Origin::Parse => return None,
            Origin::Call => Outcome::Throws,
            Origin::Global if slot(nodes, outermost(nodes, usage.node)) == Slot::Typeof => Outcome::Safe,
            Origin::Global => Outcome::Throws,
            Origin::Member | Origin::Method => match nodes.kind(usage.node) {
                AstKind::StaticMemberExpression(_) | AstKind::ComputedMemberExpression(_) => self.flow(usage.node),
                // A destructured property is bound to a name, and the value goes on from there.
                _ => Outcome::Escapes(Flow::Raw),
            },
        })
    }

    /// Table 1: the climb from the member read `start` to the end of its flow.
    fn flow(&mut self, start: NodeId) -> Outcome {
        let semantic = self.semantic;
        let nodes = semantic.nodes();
        let mut visited = Vec::new();
        let (mut id, mut flow) = (start, Flow::Raw);
        let mut outcome = loop {
            if let Some(&known) = self.flows.get(&(id, flow)) {
                break known;
            }
            count!(climb);
            let step = match slot(nodes, id) {
                Slot::Wrapper | Slot::SeqLast | Slot::Await => Step::Up(flow),
                Slot::LogicalLeft(LogicalOperator::And) | Slot::LogicalRight | Slot::CondBranch => {
                    Step::Up(Flow::Optional)
                }
                Slot::AssignValue => Step::Fork,
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
                Slot::Argument | Slot::Yield { delegate: false } | Slot::Other => Step::Done(Outcome::Escapes(flow)),
            };
            visited.push((id, flow, matches!(step, Step::Fork)));
            match step {
                Step::Done(outcome) => break outcome,
                Step::Up(next) => {
                    id = nodes.parent_id(id);
                    flow = next;
                }
                Step::Fork => id = nodes.parent_id(id),
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
        for (id, flow, fork) in visited.into_iter().rev() {
            if fork {
                outcome = outcome.max(Outcome::Escapes(flow));
            }
            self.flows.insert((id, flow), outcome);
        }
        outcome
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

    fn is_covered(&mut self, usage: &Use) -> bool {
        let Some(key) = self.key(usage) else {
            return false;
        };
        let fact = self.intern(key);
        let next = self.subjects.len();
        let subject = *self.subject_ids.entry((fact, usage.feature)).or_insert(next);
        if subject == next {
            self.subjects.push(Subject {
                fact,
                feature: usage.feature,
            });
        }
        self.climb(usage.node, subject, |guards, parent, child, subject| {
            guards.facts_of(parent, child, subject).then_some(true)
        })
    }

    fn intern(&mut self, key: Key<'a>) -> Fact {
        let next = self.fact_features.len() as Fact;
        match self.facts.entry(key) {
            Entry::Occupied(entry) => *entry.get(),
            Entry::Vacant(entry) => {
                let feature = match entry.key() {
                    Key::Path(path) => path_feature(path),
                    Key::Method(_) => None,
                };
                self.fact_features.push(feature);
                entry.insert(next);
                next
            }
        }
    }

    /// The key of the use, read from its node. `None` for a use that code cannot check: a pattern that
    /// `new RegExp` parses.
    fn key(&self, usage: &Use) -> Option<Key<'a>> {
        let semantic = self.semantic;
        let nodes = semantic.nodes();
        let member = |object: &Expression<'a>, name: &'a str| member_path(semantic, object, name).map(Key::Path);
        match (usage.origin, nodes.kind(usage.node)) {
            (Origin::Global, AstKind::IdentifierReference(identifier)) => {
                Some(Key::Path(vec![identifier.name.as_str()]))
            }
            (Origin::Method, AstKind::StaticMemberExpression(method)) => {
                Some(Key::Method(method.property.name.as_str()))
            }
            (Origin::Member, AstKind::StaticMemberExpression(read)) => {
                member(&read.object, read.property.name.as_str())
            }
            (Origin::Member, AstKind::ComputedMemberExpression(read)) => match read.expression.get_inner_expression() {
                Expression::StringLiteral(name) => member(&read.object, name.value.as_str()),
                _ => None,
            },
            (Origin::Member, AstKind::BindingProperty(property)) => member(
                destructured_source(nodes, nodes.parent_id(usage.node))?,
                key_name(&property.key)?,
            ),
            (Origin::Member, AstKind::AssignmentTargetPropertyIdentifier(property)) => member(
                destructured_source(nodes, nodes.parent_id(usage.node))?,
                property.binding.name.as_str(),
            ),
            (Origin::Member, AstKind::AssignmentTargetPropertyProperty(property)) => member(
                destructured_source(nodes, nodes.parent_id(usage.node))?,
                key_name(&property.name)?,
            ),
            _ => None,
        }
    }

    /// Table 2: whether the parent proves the subject present in its child `child`.
    fn facts_of(&mut self, parent: NodeId, child: NodeId, subject: usize) -> bool {
        let nodes = self.semantic.nodes();
        let span = nodes.kind(child).span();
        let (test, value) = match nodes.kind(parent) {
            AstKind::IfStatement(statement) if statement.consequent.span() == span => (&statement.test, true),
            AstKind::IfStatement(statement) if statement.alternate.as_ref().is_some_and(|it| it.span() == span) => {
                (&statement.test, false)
            }
            AstKind::ConditionalExpression(expression) if expression.consequent.span() == span => {
                (&expression.test, true)
            }
            AstKind::ConditionalExpression(expression) if expression.alternate.span() == span => {
                (&expression.test, false)
            }
            AstKind::WhileStatement(statement) if statement.body.span() == span => (&statement.test, true),
            AstKind::ForStatement(statement) if statement.body.span() == span => match &statement.test {
                Some(test) => (test, true),
                None => return false,
            },
            AstKind::LogicalExpression(logical) if logical.right.span() == span => match logical.operator {
                LogicalOperator::And => (&logical.left, true),
                LogicalOperator::Or => (&logical.left, false),
                LogicalOperator::Coalesce => return false,
            },
            AstKind::Program(program) => return self.list(parent, &program.body, span, subject),
            AstKind::BlockStatement(block) => return self.list(parent, &block.body, span, subject),
            AstKind::FunctionBody(body) => return self.list(parent, &body.statements, span, subject),
            AstKind::StaticBlock(block) => return self.list(parent, &block.body, span, subject),
            AstKind::SwitchCase(case) => return self.list(parent, &case.consequent, span, subject),
            _ => return false,
        };
        let facts = self.test(test, value);
        self.covers(&facts, subject)
    }

    /// `N(S)` of the statements before `child` in a statement list. The list gets an index once, so each
    /// use asks it instead of reading the statements again.
    fn list(&mut self, list: NodeId, statements: &'a [Statement<'a>], child: Span, subject: usize) -> bool {
        let index = self.list_index(list, statements);
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
            None if consequent => self.compute(&check.test, false),
            Some(alternate) => match (consequent, self.exits(alternate)) {
                (false, true) => self.compute(&check.test, true),
                (true, false) => self.compute(&check.test, false),
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

    /// `F(test, value)` for the tests that uses ask about, kept by node and value. The parts of a test
    /// are asked only by the test itself, so they are not kept.
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
                self.compute(&unary.argument, !value)
            }
            Expression::SequenceExpression(sequence) if !sequence.expressions.is_empty() => {
                self.compute(&sequence.expressions[sequence.expressions.len() - 1], value)
            }
            Expression::AssignmentExpression(assignment) if assignment.operator == AssignmentOperator::Assign => {
                self.compute(&assignment.right, value)
            }
            Expression::CallExpression(call) if is_boolean(semantic, &call.callee) => match call.arguments.as_slice() {
                [argument] if let Some(argument) = argument.as_expression() => self.compute(argument, value),
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
                    let next = self.compute(operand, value);
                    facts = self.intersect(&facts, &next);
                    if matches!(&facts, Facts::Set(set) if set.facts.is_empty() && set.features.is_empty()) {
                        break;
                    }
                }
                facts
            }
            Expression::ConditionalExpression(conditional) => {
                let (yes, then) = (
                    self.compute(&conditional.test, true),
                    self.compute(&conditional.consequent, value),
                );
                let (no, otherwise) = (
                    self.compute(&conditional.test, false),
                    self.compute(&conditional.alternate, value),
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
            let facts = self.compute(operand, value);
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
    fn present(&mut self, value: &'a Expression<'a>, name: Option<&'a str>) -> Facts {
        let semantic = self.semantic;
        let (path, method) = match name {
            Some(name) => (member_path(semantic, value, name), Some(name)),
            None => (path(semantic, value), as_member(value).and_then(property)),
        };
        let mut set = FactSet::default();
        if let Some(path) = path {
            let fact = self.intern(Key::Path(path));
            set.facts.push(fact);
            set.features.extend(self.fact_features[fact as usize]);
        }
        if let Some(method) = method {
            set.facts.push(self.intern(Key::Method(method)));
        }
        set.facts.sort_unstable();
        Facts::Set(Rc::new(set))
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
                .filter(|feature| other_features.contains(feature))
                .collect(),
        }))
    }

    /// Whether the facts cover the subject: they hold its key, or they name a feature that every target
    /// version without full support of the subject lacks too.
    fn covers(&mut self, facts: &Facts, subject: usize) -> bool {
        let Subject { fact, feature } = self.subjects[subject];
        let features = match facts {
            Facts::All => return true,
            Facts::Set(set) => {
                if set.facts.binary_search(&fact).is_ok() {
                    return true;
                }
                set.features.clone()
            }
            &Facts::Range {
                index: range,
                start,
                end,
            } => {
                let index = &self.indexes[range];
                if index.holds(ALL, start, end) || index.holds(fact, start, end) {
                    return true;
                }
                let features = index.features(start, end);
                if self.nested_covers(range, start, end, subject) {
                    return true;
                }
                features
            }
        };
        features.into_iter().any(|checked| {
            *self
                .implied
                .entry((checked, feature))
                .or_insert_with(|| self.targets.implies(checked, feature))
        })
    }
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
pub(crate) fn key_text(semantic: &Semantic<'_>, usage: &Use) -> Option<String> {
    let targets = Targets::missing_everything();
    match Guards::new(semantic, &targets).key(usage)? {
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

//! Feature checks in the code: `'Segmenter' in Intl`, `typeof structuredClone`, `x && x()`, an early
//! `return`, a `try` around a call, an optional call `x.m?.()` or an optional member access `x?.y`.
//! A use under a check of the same feature is not a finding. Syntax cannot be checked this way, so
//! syntax uses have no keys.
//!
//! A test sees through what passes the value on unchanged: parentheses, the last expression of a
//! sequence and a call of the global `Boolean`. Coverage instrumentation wraps tested operands in
//! sequences, `(cov().b[1][1]++, navigator.share)`.
//!
//! A check names a global only when the root of its chain is not declared in the file: a local `Intl`
//! or `window` is another object. The key `#name` is the exception. The methods detector finds a
//! method by its name and does not know the object, so a check of `a.toSorted` guards `b.toSorted()`.

use std::collections::HashMap;

use oxc_ast::AstKind;
use oxc_ast::ast::{
    BinaryExpression, BinaryOperator, CallExpression, ChainElement, Expression, IdentifierReference, LogicalExpression,
    LogicalOperator, MemberExpression, SequenceExpression, Statement, UnaryOperator,
};
use oxc_semantic::{AstNodes, NodeId, Semantic};
use oxc_span::{GetSpan, Span};

use super::{Use, WINDOW_ALIASES};

/// Finds the checks around uses. One instance serves all uses of a file, so the keys of early exits
/// in a statement list and the keys of `&&` and `||` chains are collected once, not once per use.
pub struct Guards<'s, 'a> {
    semantic: &'s Semantic<'a>,
    /// For each statement list, by the node that holds it: every key that an early exit
    /// `if (!X) return;` checks, with the index of the first such statement.
    early_exits: HashMap<NodeId, HashMap<String, usize>>,
    /// The keys of a test, by the test node and the value of the test: with `true`, the keys that are
    /// present when the test is true.
    tests: HashMap<(NodeId, bool), TestKeys>,
    /// For each `&&` or `||` chain: every key, with the indexes of the operands that check it.
    chains: Vec<HashMap<String, Vec<usize>>>,
    /// For each logical expression: whether `undefined` as its value throws, as in `(a || X)(y)`.
    throwing_logicals: HashMap<NodeId, bool>,
}

enum TestKeys {
    Own(Vec<String>),
    /// The operands `start..end` of a chain in `Guards::chains`.
    Operands {
        chain: usize,
        start: usize,
        end: usize,
    },
}

impl<'s, 'a> Guards<'s, 'a> {
    pub fn new(semantic: &'s Semantic<'a>) -> Self {
        Self {
            semantic,
            early_exits: HashMap::new(),
            tests: HashMap::new(),
            chains: Vec::new(),
            throwing_logicals: HashMap::new(),
        }
    }

    pub fn is_guarded(&mut self, usage: &Use) -> bool {
        let detectable = !usage.keys.is_empty();
        // Nothing can check such a use, and the walk below costs a pass over its ancestors.
        if !detectable && !usage.catchable {
            return false;
        }
        let semantic = self.semantic;
        let nodes = semantic.nodes();
        let span = usage.span;
        let call = enclosing_call(nodes, usage);
        if usage.catchable && call.is_some_and(|(optional, callee_is_member)| optional && callee_is_member) {
            return true;
        }
        let called = call.is_some();
        // Reading a member returns `undefined` when the feature is missing, so the read is the check itself.
        // A bare global throws `ReferenceError` instead, so reading it is a use.
        // `(a || X)(y)` calls `undefined` when `X` is missing, so `X` is used and not tested.
        let member_read =
            detectable && !called && is_member(nodes.kind(usage.node)) && !self.missing_value_throws(usage.node);
        if member_read && (is_optional_object(nodes, usage.node) || is_boolean_read(semantic, usage.node)) {
            return true;
        }
        let node_span = nodes.kind(usage.node).span();
        // The use is the tested value of the node that the walk comes from: `X`, `!X`, `A && X`, `X != null`.
        // The walk keeps this flag instead of searching each tested expression for the use, which made
        // long `||` chains cubic.
        let mut tested = member_read;
        let mut crossed_function = false;
        let mut child = node_span;
        for ancestor in nodes.ancestors(usage.node) {
            let kind = ancestor.kind();
            let guarded = match kind {
                AstKind::Function(_) | AstKind::ArrowFunctionExpression(_) => {
                    crossed_function = true;
                    false
                }
                AstKind::UnaryExpression(unary) => {
                    // `typeof x.m()` calls `m`. The use of the methods detector is the call itself,
                    // so its span is the argument of `typeof`, and only `called` tells it apart.
                    detectable
                        && !called
                        && unary.operator == UnaryOperator::Typeof
                        && unary.argument.get_inner_expression().span() == node_span
                }
                AstKind::IfStatement(statement) => self.branch(
                    usage,
                    tested,
                    &statement.test,
                    statement.consequent.span(),
                    statement.alternate.as_ref().map(GetSpan::span),
                ),
                AstKind::ConditionalExpression(expression) => self.branch(
                    usage,
                    tested,
                    &expression.test,
                    expression.consequent.span(),
                    Some(expression.alternate.span()),
                ),
                AstKind::LogicalExpression(expression) => self.logical(usage, tested, expression),
                AstKind::TryStatement(statement) => {
                    // A `try` does not reach into a callback: it runs after the `try` has finished.
                    usage.catchable
                        && called
                        && !crossed_function
                        && statement.handler.is_some()
                        && within(statement.block.span, span)
                }
                AstKind::BlockStatement(block) => {
                    detectable && self.after_early_exit(ancestor.id(), &block.body, usage)
                }
                AstKind::FunctionBody(body) => {
                    detectable && self.after_early_exit(ancestor.id(), &body.statements, usage)
                }
                AstKind::Program(program) => detectable && self.after_early_exit(ancestor.id(), &program.body, usage),
                AstKind::SwitchCase(case) => {
                    detectable && self.after_early_exit(ancestor.id(), &case.consequent, usage)
                }
                AstKind::StaticBlock(block) => detectable && self.after_early_exit(ancestor.id(), &block.body, usage),
                _ => false,
            };
            if guarded {
                return true;
            }
            tested = tested && passes_tested_value(kind, child);
            child = kind.span();
        }
        false
    }

    fn branch(
        &mut self,
        usage: &Use,
        tested: bool,
        test: &'a Expression<'a>,
        consequent: Span,
        alternate: Option<Span>,
    ) -> bool {
        if usage.keys.is_empty() {
            return false;
        }
        if within(test.span(), usage.span) {
            return tested;
        }
        if within(consequent, usage.span) {
            return self.checks(test, true, usage);
        }
        alternate.is_some_and(|alternate| within(alternate, usage.span)) && self.checks(test, false, usage)
    }

    fn logical(&mut self, usage: &Use, tested: bool, expression: &'a LogicalExpression<'a>) -> bool {
        if usage.keys.is_empty() {
            return false;
        }
        if within(expression.left.span(), usage.span) {
            // `const ua = navigator.userAgentData || null` is guarded, though the result is a value and
            // not a test: reading a member does not throw, and the code that uses the result checks it.
            return tested;
        }
        within(expression.right.span(), usage.span)
            && match expression.operator {
                LogicalOperator::And => self.checks(&expression.left, true, usage),
                LogicalOperator::Or => self.checks(&expression.left, false, usage),
                LogicalOperator::Coalesce => false,
            }
    }

    /// Whether `test` checks a key of `usage` when the value of `test` is `value`.
    fn checks(&mut self, test: &'a Expression<'a>, value: bool, usage: &Use) -> bool {
        let (test, value) = without_not(self.semantic, test, value);
        let key = (test.node_id(), value);
        if !self.tests.contains_key(&key) {
            self.index(test, value);
        }
        match self.tests.get(&key) {
            Some(TestKeys::Own(keys)) => matches(usage, keys),
            Some(&TestKeys::Operands { chain, start, end }) => usage.keys.iter().any(|key| {
                self.chains[chain].get(key).is_some_and(|operands| {
                    let first = operands.partition_point(|&operand| operand < start);
                    operands.get(first).is_some_and(|&operand| operand < end)
                })
            }),
            None => false,
        }
    }

    /// Stores the keys of `test`. When `test` is a part of an `&&` or `||` chain, stores the keys of
    /// every part of the outermost chain at once. A use in operand N of a chain asks for the keys of
    /// operands 0..N, so collecting them on each request made a long chain quadratic.
    fn index(&mut self, test: &'a Expression<'a>, value: bool) {
        let semantic = self.semantic;
        let nodes = semantic.nodes();
        let mut root = join_of(semantic, test, value).map(|logical| (logical, value));
        let mut id = test.node_id();
        let mut current = value;
        loop {
            let parent = nodes.parent_id(id);
            match nodes.kind(parent) {
                kind if passes_value(semantic, kind, nodes.kind(id).span()) => {}
                AstKind::UnaryExpression(unary) if unary.operator == UnaryOperator::LogicalNot => current = !current,
                AstKind::LogicalExpression(logical) if joins(logical.operator, current) => {
                    root = Some((logical, current));
                }
                _ => break,
            }
            id = parent;
        }
        match root {
            Some((logical, value)) => self.index_chain(logical, value),
            None => {
                let keys = own_keys(self.semantic, test, value);
                self.tests.insert((test.node_id(), value), TestKeys::Own(keys));
            }
        }
    }

    fn index_chain(&mut self, root: &'a LogicalExpression<'a>, value: bool) {
        enum Step<'a> {
            Join(&'a LogicalExpression<'a>, bool),
            Close(NodeId, bool, usize),
            Operand(&'a Expression<'a>, bool),
        }
        let chain = self.chains.len();
        let mut operands: HashMap<String, Vec<usize>> = HashMap::new();
        let mut count = 0;
        // A stack instead of recursion: a chain of thousands of operands is as deep as it is long.
        let mut steps = vec![Step::Join(root, value)];
        while let Some(step) = steps.pop() {
            match step {
                Step::Join(logical, value) => {
                    steps.push(Step::Close(logical.node_id(), value, count));
                    steps.push(Step::Operand(&logical.right, value));
                    steps.push(Step::Operand(&logical.left, value));
                }
                Step::Close(id, value, start) => {
                    self.tests.insert(
                        (id, value),
                        TestKeys::Operands {
                            chain,
                            start,
                            end: count,
                        },
                    );
                }
                Step::Operand(expression, value) => {
                    let (expression, value) = without_not(self.semantic, expression, value);
                    if let Some(logical) = join_of(self.semantic, expression, value) {
                        steps.push(Step::Join(logical, value));
                        continue;
                    }
                    for key in own_keys(self.semantic, expression, value) {
                        operands.entry(key).or_default().push(count);
                    }
                    self.tests.insert(
                        (expression.node_id(), value),
                        TestKeys::Operands {
                            chain,
                            start: count,
                            end: count + 1,
                        },
                    );
                    count += 1;
                }
            }
        }
        self.chains.push(operands);
    }

    /// Whether `undefined` in place of the member read `node` reaches a position that throws on it. The
    /// value passes through wrappers and logical expressions, except the left operand of `||` and `??`:
    /// the right operand replaces a missing member there. The verdict of each logical expression is kept,
    /// so the uses of a long chain do not walk the chain again.
    fn missing_value_throws(&mut self, node: NodeId) -> bool {
        let nodes = self.semantic.nodes();
        let mut id = node;
        let mut logicals = Vec::new();
        let throws = loop {
            let parent = nodes.parent_id(id);
            let span = nodes.kind(id).span();
            match nodes.kind(parent) {
                AstKind::LogicalExpression(logical) => {
                    if logical.operator != LogicalOperator::And && logical.left.span() == span {
                        break false;
                    }
                    if let Some(&throws) = self.throwing_logicals.get(&parent) {
                        break throws;
                    }
                    logicals.push(parent);
                }
                // `(0, a || X)(y)` calls the last expression of the sequence.
                AstKind::SequenceExpression(sequence) => {
                    if sequence.expressions.last().is_none_or(|last| last.span() != span) {
                        break false;
                    }
                }
                AstKind::ChainExpression(_) => {}
                kind if is_wrapper(kind) => {}
                _ => break throws_on_undefined(nodes, parent, span),
            }
            id = parent;
        };
        for logical in logicals {
            self.throwing_logicals.insert(logical, throws);
        }
        throws
    }

    /// `if (!X) return;` before the use, in the same statement list.
    fn after_early_exit(&mut self, list: NodeId, statements: &[Statement<'_>], usage: &Use) -> bool {
        let position = statements.partition_point(|statement| statement.span().end <= usage.span.start);
        if !statements
            .get(position)
            .is_some_and(|statement| within(statement.span(), usage.span))
        {
            return false;
        }
        let semantic = self.semantic;
        let first_exits = self
            .early_exits
            .entry(list)
            .or_insert_with(|| early_exit_keys(semantic, statements));
        usage
            .keys
            .iter()
            .any(|key| first_exits.get(key).is_some_and(|&first| first < position))
    }
}

fn early_exit_keys(semantic: &Semantic<'_>, statements: &[Statement<'_>]) -> HashMap<String, usize> {
    let mut first_exits = HashMap::new();
    for (index, statement) in statements.iter().enumerate() {
        if let Statement::IfStatement(check) = statement
            && check.alternate.is_none()
            && exits(&check.consequent)
        {
            for key in all_keys(semantic, &check.test, false) {
                first_exits.entry(key).or_insert(index);
            }
        }
    }
    first_exits
}

/// Whether `kind` passes on the tested value from its child with `span`: `!X`, `A && X`, `(X)`, `X?.y`,
/// `X != null`, `(a, X)`. A comparison reads the member and does not throw, whatever the other operand is.
/// A member read that the code dereferences, `X.y`, throws when `X` is missing, so it is not a check.
fn passes_tested_value(kind: AstKind<'_>, span: Span) -> bool {
    match kind {
        AstKind::ChainExpression(_) | AstKind::LogicalExpression(_) => true,
        AstKind::SequenceExpression(sequence) => is_last(sequence, span),
        AstKind::UnaryExpression(unary) => unary.operator == UnaryOperator::LogicalNot,
        AstKind::BinaryExpression(binary) => is_equality(binary.operator),
        kind => is_wrapper(kind),
    }
}

/// `(X)`, `X as T`, `X satisfies T`, `X<T>`, `X!`, `<T>X`: the nodes that `get_inner_expression` skips.
fn is_wrapper(kind: AstKind<'_>) -> bool {
    matches!(
        kind,
        AstKind::ParenthesizedExpression(_)
            | AstKind::TSAsExpression(_)
            | AstKind::TSSatisfiesExpression(_)
            | AstKind::TSInstantiationExpression(_)
            | AstKind::TSNonNullExpression(_)
            | AstKind::TSTypeAssertion(_)
    )
}

/// Whether `kind` has the value of its child with `span`: a wrapper, a sequence that ends with the child,
/// or `Boolean(X)`, whose truth is the truth of `X`. The inverse of `tested_value`.
fn passes_value(semantic: &Semantic<'_>, kind: AstKind<'_>, span: Span) -> bool {
    match kind {
        AstKind::SequenceExpression(sequence) => is_last(sequence, span),
        AstKind::CallExpression(call) => {
            boolean_argument(semantic, call).is_some_and(|argument| argument.span() == span)
        }
        kind => is_wrapper(kind),
    }
}

/// The expression whose truth `test` has: `X` for `(X)`, `(a, X)` and `Boolean(X)`. The value of a
/// sequence is its last expression, and the other expressions do not count.
fn tested_value<'b, 'a>(semantic: &Semantic<'_>, mut test: &'b Expression<'a>) -> &'b Expression<'a> {
    loop {
        test = match test.get_inner_expression() {
            Expression::SequenceExpression(sequence) => match sequence.expressions.last() {
                Some(last) => last,
                None => return test.get_inner_expression(),
            },
            Expression::CallExpression(call) => match boolean_argument(semantic, call) {
                Some(argument) => argument,
                None => return test.get_inner_expression(),
            },
            inner => return inner,
        };
    }
}

/// `X` in `Boolean(X)` with the global `Boolean` and one argument that is not a spread.
fn boolean_argument<'b, 'a>(semantic: &Semantic<'_>, call: &'b CallExpression<'a>) -> Option<&'b Expression<'a>> {
    let Expression::Identifier(callee) = call.callee.get_inner_expression() else {
        return None;
    };
    if callee.name != "Boolean" || !is_global(semantic, callee) {
        return None;
    }
    match call.arguments.as_slice() {
        [argument] => argument.as_expression(),
        _ => None,
    }
}

fn is_last(sequence: &SequenceExpression<'_>, span: Span) -> bool {
    sequence.expressions.last().is_some_and(|last| last.span() == span)
}

/// `X?.y` and `X?.m()`: optional chaining reads nothing from a missing `X`.
fn is_optional_object(nodes: &AstNodes<'_>, node: NodeId) -> bool {
    let mut id = node;
    while is_wrapper(nodes.parent_kind(id)) {
        id = nodes.parent_id(id);
    }
    let span = nodes.kind(id).span();
    match nodes.parent_kind(id) {
        AstKind::StaticMemberExpression(member) => member.optional && member.object.span() == span,
        AstKind::ComputedMemberExpression(member) => member.optional && member.object.span() == span,
        _ => false,
    }
}

/// A member read whose value serves only as a boolean: `!X`, `Boolean(X)`, an operand of `&&`, `||` or
/// `??`, the test of `?:`, an operand of a comparison. A missing member reads as `undefined`, so such a
/// read is a check. Only the parent counts: `Boolean(X.y)` reads from `X`, and `f(!X)` is still a check.
/// The parent of `X` in `(a, X)` is the parent of the sequence.
fn is_boolean_read(semantic: &Semantic<'_>, node: NodeId) -> bool {
    let nodes = semantic.nodes();
    let mut id = node;
    // `a?.X` keeps the value, and `a?.X.y` does not end the chain at `X`.
    loop {
        let span = nodes.kind(id).span();
        match nodes.parent_kind(id) {
            AstKind::ChainExpression(_) => {}
            AstKind::SequenceExpression(sequence) if is_last(sequence, span) => {}
            kind if is_wrapper(kind) => {}
            _ => break,
        }
        id = nodes.parent_id(id);
    }
    let span = nodes.kind(id).span();
    match nodes.parent_kind(id) {
        AstKind::UnaryExpression(unary) => unary.operator == UnaryOperator::LogicalNot,
        AstKind::LogicalExpression(_) => true,
        AstKind::ConditionalExpression(expression) => expression.test.span() == span,
        AstKind::BinaryExpression(binary) => binary.operator.is_equality() || binary.operator.is_compare(),
        // A spread argument has its own span, so `Boolean(...X)` does not match.
        AstKind::CallExpression(call) => {
            matches!(call.callee.get_inner_expression(), Expression::Identifier(callee) if callee.name == "Boolean" && is_global(semantic, callee))
                && call.arguments.first().is_some_and(|argument| argument.span() == span)
        }
        _ => false,
    }
}

/// Whether the child with `span` of `parent` throws when it is `undefined`: a callee, a tag, the object
/// of a member, a spread into an array or arguments, the source of `for of`, `yield*`, `extends` and of
/// a destructuring, the right operand of `in`. A spread into an object skips `undefined`.
fn throws_on_undefined(nodes: &AstNodes<'_>, parent: NodeId, span: Span) -> bool {
    match nodes.kind(parent) {
        AstKind::CallExpression(call) => !call.optional && call.callee.span() == span,
        AstKind::NewExpression(expression) => expression.callee.span() == span,
        AstKind::TaggedTemplateExpression(expression) => expression.tag.span() == span,
        AstKind::StaticMemberExpression(member) => !member.optional && member.object.span() == span,
        AstKind::ComputedMemberExpression(member) => !member.optional && member.object.span() == span,
        AstKind::PrivateFieldExpression(member) => !member.optional && member.object.span() == span,
        AstKind::SpreadElement(_) => !matches!(nodes.parent_kind(parent), AstKind::ObjectExpression(_)),
        AstKind::ForOfStatement(statement) => statement.right.span() == span,
        AstKind::YieldExpression(expression) => expression.delegate,
        AstKind::Class(class) => class
            .heritage
            .as_ref()
            .is_some_and(|heritage| heritage.expression.span() == span),
        AstKind::VariableDeclarator(declarator) => !declarator.id.is_binding_identifier(),
        AstKind::AssignmentExpression(assignment) => {
            assignment.right.span() == span && assignment.left.is_assignment_target_pattern()
        }
        AstKind::AssignmentTargetWithDefault(target) => {
            target.init.span() == span && target.binding.is_assignment_target_pattern()
        }
        AstKind::AssignmentPattern(pattern) => pattern.right.span() == span && !pattern.left.is_binding_identifier(),
        AstKind::FormalParameter(parameter) => {
            parameter
                .initializer
                .as_ref()
                .is_some_and(|initializer| initializer.span() == span)
                && !parameter.pattern.is_binding_identifier()
        }
        AstKind::BinaryExpression(binary) => {
            matches!(binary.operator, BinaryOperator::In | BinaryOperator::Instanceof) && binary.right.span() == span
        }
        _ => false,
    }
}

/// The call whose callee is the use, or the use itself when it is a call: `(optional, callee is a member)`.
/// The callee may wrap the use: `(0, window.structuredClone)(x)`, `(window.structuredClone as F)(x)`
/// and `(window?.structuredClone)(x)`.
fn enclosing_call(nodes: &AstNodes<'_>, usage: &Use) -> Option<(bool, bool)> {
    let describe = |callee: &Expression<'_>, optional: bool| (optional, as_member(callee).is_some());
    match nodes.kind(usage.node) {
        AstKind::CallExpression(call) => return Some(describe(&call.callee, call.optional)),
        AstKind::NewExpression(expression) => return Some(describe(&expression.callee, false)),
        _ => {}
    }
    let mut id = usage.node;
    let mut span = usage.span;
    loop {
        let parent = nodes.parent_id(id);
        let lifts = match nodes.kind(parent) {
            AstKind::SequenceExpression(sequence) => {
                sequence.expressions.last().is_some_and(|last| last.span() == span)
            }
            // `(window?.X)(y)`: the optional chain ends at the parentheses, and the call is outside it.
            AstKind::ChainExpression(_) => true,
            kind => is_wrapper(kind),
        };
        if !lifts {
            break;
        }
        id = parent;
        span = nodes.kind(id).span();
    }
    let member = is_member(nodes.kind(usage.node));
    match nodes.parent_kind(id) {
        AstKind::CallExpression(call) if call.callee.span() == span => Some((call.optional, member)),
        AstKind::NewExpression(expression) if expression.callee.span() == span => Some((false, member)),
        _ => None,
    }
}

fn is_member(kind: AstKind<'_>) -> bool {
    matches!(
        kind,
        AstKind::StaticMemberExpression(_) | AstKind::ComputedMemberExpression(_)
    )
}

fn exits(statement: &Statement<'_>) -> bool {
    match statement {
        Statement::ReturnStatement(_)
        | Statement::ThrowStatement(_)
        | Statement::ContinueStatement(_)
        | Statement::BreakStatement(_) => true,
        Statement::BlockStatement(block) => block.body.last().is_some_and(exits),
        _ => false,
    }
}

fn matches(usage: &Use, keys: &[String]) -> bool {
    usage.keys.iter().any(|key| keys.contains(key))
}

/// `!X` with the value `v` is `X` with the value `!v`. The result is a `tested_value`.
fn without_not<'b, 'a>(
    semantic: &Semantic<'_>,
    mut test: &'b Expression<'a>,
    mut value: bool,
) -> (&'b Expression<'a>, bool) {
    loop {
        match tested_value(semantic, test) {
            Expression::UnaryExpression(unary) if unary.operator == UnaryOperator::LogicalNot => {
                value = !value;
                test = &unary.argument;
            }
            inner => return (inner, value),
        }
    }
}

/// `A && B` is true when both are true, `A || B` is false when both are false. Then the keys of the
/// test are the keys of both operands.
fn joins(operator: LogicalOperator, value: bool) -> bool {
    matches!(
        (operator, value),
        (LogicalOperator::And, true) | (LogicalOperator::Or, false)
    )
}

fn join_of<'b, 'a>(
    semantic: &Semantic<'_>,
    test: &'b Expression<'a>,
    value: bool,
) -> Option<&'b LogicalExpression<'a>> {
    match tested_value(semantic, test) {
        Expression::LogicalExpression(logical) if joins(logical.operator, value) => Some(logical),
        _ => None,
    }
}

/// Features that are present when `test` has the value `value`.
fn all_keys(semantic: &Semantic<'_>, test: &Expression<'_>, value: bool) -> Vec<String> {
    let mut keys = Vec::new();
    let mut operands = vec![(test, value)];
    while let Some((operand, value)) = operands.pop() {
        let (operand, value) = without_not(semantic, operand, value);
        match join_of(semantic, operand, value) {
            Some(logical) => {
                operands.push((&logical.right, value));
                operands.push((&logical.left, value));
            }
            None => keys.extend(own_keys(semantic, operand, value)),
        }
    }
    keys
}

/// Features that are present when `test` has the value `value`, for a test that is neither `!X` nor
/// a chain that `joins`.
fn own_keys(semantic: &Semantic<'_>, test: &Expression<'_>, value: bool) -> Vec<String> {
    let binary = match tested_value(semantic, test) {
        Expression::BinaryExpression(binary) => binary,
        other if value => return chain_keys(semantic, other),
        _ => return Vec::new(),
    };
    match (binary.operator, value) {
        (BinaryOperator::In, true) => in_keys(semantic, binary),
        (BinaryOperator::LessThan | BinaryOperator::GreaterThan, _) => minified_typeof_keys(semantic, binary, value),
        (BinaryOperator::Inequality | BinaryOperator::StrictInequality, true)
        | (BinaryOperator::Equality | BinaryOperator::StrictEquality, false) => {
            let mut keys = typeof_keys(semantic, binary, |kind| kind == "undefined");
            keys.extend(undefined_keys(semantic, binary));
            keys
        }
        (BinaryOperator::Equality | BinaryOperator::StrictEquality, true)
        | (BinaryOperator::Inequality | BinaryOperator::StrictInequality, false) => {
            typeof_keys(semantic, binary, |kind| kind == "function" || kind == "object")
        }
        _ => Vec::new(),
    }
}

/// `'name' in object`.
fn in_keys(semantic: &Semantic<'_>, binary: &BinaryExpression<'_>) -> Vec<String> {
    let Expression::StringLiteral(name) = binary.left.get_inner_expression() else {
        return Vec::new();
    };
    let name = name.value.as_str();
    chain(semantic, &binary.right)
        .map(|object| join(&object, name))
        .into_iter()
        .chain(std::iter::once(format!("#{name}")))
        .collect()
}

/// `typeof chain === 'kind'` in either order.
fn typeof_keys(semantic: &Semantic<'_>, binary: &BinaryExpression<'_>, accept: impl Fn(&str) -> bool) -> Vec<String> {
    let (unary, literal) = match (binary.left.get_inner_expression(), binary.right.get_inner_expression()) {
        (Expression::UnaryExpression(unary), Expression::StringLiteral(literal))
        | (Expression::StringLiteral(literal), Expression::UnaryExpression(unary)) => (unary, literal),
        _ => return Vec::new(),
    };
    if unary.operator != UnaryOperator::Typeof || !accept(literal.value.as_str()) {
        return Vec::new();
    }
    chain_keys(semantic, &unary.argument)
}

/// The chain itself, if it names a global, and `#name` for its last member.
fn chain_keys(semantic: &Semantic<'_>, expression: &Expression<'_>) -> Vec<String> {
    let method = as_member(expression)
        .and_then(property_name)
        .map(|name| format!("#{name}"));
    chain(semantic, expression).into_iter().chain(method).collect()
}

/// `a.b['c']` and `a?.b.c` as `a.b.c`. `window.X` is `X`. `None` when the root is not a global.
fn chain(semantic: &Semantic<'_>, expression: &Expression<'_>) -> Option<String> {
    if let Expression::Identifier(identifier) = expression.get_inner_expression() {
        return is_global(semantic, identifier).then(|| identifier.name.as_str().to_string());
    }
    let member = as_member(expression)?;
    Some(join(&chain(semantic, member.object())?, property_name(member)?))
}

/// The member expression in `expression`, also inside an optional chain.
fn as_member<'b, 'a>(expression: &'b Expression<'a>) -> Option<&'b MemberExpression<'a>> {
    match expression.get_inner_expression() {
        Expression::ChainExpression(chain) => match &chain.expression {
            ChainElement::TSNonNullExpression(non_null) => as_member(&non_null.expression),
            element => element.as_member_expression(),
        },
        other => other.as_member_expression(),
    }
}

fn property_name<'b>(member: &'b MemberExpression<'_>) -> Option<&'b str> {
    match member {
        MemberExpression::StaticMemberExpression(member) => Some(member.property.name.as_str()),
        MemberExpression::ComputedMemberExpression(member) => match member.expression.get_inner_expression() {
            Expression::StringLiteral(name) => Some(name.value.as_str()),
            _ => None,
        },
        MemberExpression::PrivateFieldExpression(_) => None,
    }
}

/// A reference that resolves to no declaration in the file.
fn is_global(semantic: &Semantic<'_>, identifier: &IdentifierReference<'_>) -> bool {
    semantic
        .scoping()
        .get_reference(identifier.reference_id())
        .symbol_id()
        .is_none()
}

fn join(object: &str, property: &str) -> String {
    if WINDOW_ALIASES.contains(&object) {
        property.to_string()
    } else {
        format!("{object}.{property}")
    }
}

fn within(outer: Span, inner: Span) -> bool {
    outer.start <= inner.start && inner.end <= outer.end
}

/// esbuild writes `typeof X !== "undefined"` as `typeof X < "u"`, and `typeof X === "undefined"` as
/// `typeof X > "u"`. `present` selects the form that means "X is present".
fn minified_typeof_keys(semantic: &Semantic<'_>, binary: &BinaryExpression<'_>, present: bool) -> Vec<String> {
    let is_u = |expression: &Expression<'_>| matches!(expression.get_inner_expression(), Expression::StringLiteral(literal) if literal.value == "u");
    let typeof_argument = |expression: &Expression<'_>| match expression.get_inner_expression() {
        Expression::UnaryExpression(unary) if unary.operator == UnaryOperator::Typeof => {
            Some(chain_keys(semantic, &unary.argument))
        }
        _ => None,
    };
    // `typeof X < "u"` and `"u" > typeof X` mean present; `typeof X > "u"` and `"u" < typeof X` mean missing.
    let (operand, operand_is_left) = if is_u(&binary.right) {
        (&binary.left, true)
    } else if is_u(&binary.left) {
        (&binary.right, false)
    } else {
        return Vec::new();
    };
    let less_than = binary.operator == BinaryOperator::LessThan;
    let means_present = less_than == operand_is_left;
    if means_present != present {
        return Vec::new();
    }
    typeof_argument(operand).unwrap_or_default()
}

/// The member chain that `binary` compares with `undefined`, `void 0` or, with `==` and `!=`, with
/// `null`. `undefined == null`, but `undefined !== null`. Member chains only, `X?.y` included: a bare
/// global compared to `undefined` throws when it is missing.
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
    let operand = if is_undefined(&binary.right) {
        &binary.left
    } else if is_undefined(&binary.left) {
        &binary.right
    } else {
        return None;
    };
    as_member(operand).is_some().then_some(operand)
}

/// `X !== undefined`, `void 0 !== X`, `X != null` and the `==` forms. Callers pick the sign by operator.
fn undefined_keys(semantic: &Semantic<'_>, binary: &BinaryExpression<'_>) -> Vec<String> {
    compared_with_undefined(semantic, binary)
        .map(|operand| chain_keys(semantic, operand))
        .unwrap_or_default()
}

fn is_equality(operator: BinaryOperator) -> bool {
    matches!(
        operator,
        BinaryOperator::Equality
            | BinaryOperator::StrictEquality
            | BinaryOperator::Inequality
            | BinaryOperator::StrictInequality
    )
}

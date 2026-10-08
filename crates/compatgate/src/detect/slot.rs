//! The position of a node in its parent: one classifier for the detectors, the flow of a value in
//! the guards and the syntax detector. A position is found by the span of the child, so a child
//! must be a direct child of its parent.

use oxc_ast::AstKind;
use oxc_ast::ast::{
    AssignmentOperator, AssignmentTarget, BinaryOperator, BindingPattern, Expression, LogicalOperator, UnaryOperator,
};
use oxc_semantic::{AstNodes, NodeId, Semantic};
use oxc_span::GetSpan;

use super::path::path;

/// What a spread element spreads into.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpreadInto {
    Array,
    Call,
    Object,
}

/// The position of a child in its parent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Slot {
    /// `(X)`, `X as T`, `X!`, `X satisfies T`, `<T>X`, `X<T>`, and the end of an optional chain.
    Wrapper,
    /// The last expression of a sequence: `(a, X)`.
    SeqLast,
    /// Another expression of a sequence: `(X, a)`.
    SeqDiscard,
    /// `X.y`, `X[k]`, `X.#p`, and `X?.y` with `optional`.
    Object {
        optional: bool,
    },
    /// `X()`, and `X?.()` with `optional`.
    Callee {
        optional: bool,
    },
    NewCallee,
    /// An argument of a call or of `new`.
    Argument,
    /// `` X`…` ``.
    Tag,
    LogicalLeft(LogicalOperator),
    LogicalRight(LogicalOperator),
    /// `X ? a : b`.
    CondTest,
    /// `c ? X : a`.
    CondConsequent,
    /// `c ? a : X`.
    CondAlternate,
    /// The test of `if`, `while`, `do … while` and `for`.
    Test,
    /// `if (c) X`.
    IfConsequent,
    /// `if (c) a; else X`.
    IfAlternate,
    /// The body of `while` and of `for`, which runs only after its test is true.
    LoopBody,
    Not,
    Typeof,
    Void,
    Delete,
    /// An operand of `==`, `!=`, `===`, `!==`, `<`, `<=`, `>` or `>=`.
    Compare,
    InstanceofLeft,
    InstanceofRight,
    /// `'p' in X`.
    InRight,
    /// `...X`.
    Spread {
        into: SpreadInto,
    },
    /// `for (a of X)`.
    ForOfRight,
    /// `for (a in X)`.
    ForInRight,
    /// The value that a pattern destructures: `const { a } = X`, `[a] = X`, `function f({ a } = X) {}`.
    DestructuringSource,
    /// A place that the code writes: `X = v`, `[X] = a`, `({ a: X } = o)`, `for (X of list)`.
    AssignTarget,
    /// The value of an assignment to a name or a member: `y = X`.
    AssignValue,
    Await,
    Yield {
        delegate: bool,
    },
    /// `class C extends X {}`.
    Extends,
    /// `X;` and the init and the update of `for (X; ; X)`: the value is dropped.
    Statement,
    Other,
}

/// The position of `child` in its parent.
pub fn slot(nodes: &AstNodes<'_>, child: NodeId) -> Slot {
    // Most positions need no comparison, so the span of the child waits for the first one.
    let is = |expression: &dyn GetSpan| expression.span() == nodes.kind(child).span();
    match nodes.parent_kind(child) {
        kind if is_wrapper(kind) => Slot::Wrapper,
        AstKind::SequenceExpression(sequence) => {
            if sequence.expressions.last().is_some_and(|last| is(last)) {
                Slot::SeqLast
            } else {
                Slot::SeqDiscard
            }
        }
        AstKind::StaticMemberExpression(member) if is(&member.object) => Slot::Object {
            optional: member.optional,
        },
        AstKind::ComputedMemberExpression(member) if is(&member.object) => Slot::Object {
            optional: member.optional,
        },
        AstKind::PrivateFieldExpression(member) if is(&member.object) => Slot::Object {
            optional: member.optional,
        },
        AstKind::CallExpression(call) if is(&call.callee) => Slot::Callee {
            optional: call.optional,
        },
        AstKind::CallExpression(_) => Slot::Argument,
        AstKind::NewExpression(expression) if is(&expression.callee) => Slot::NewCallee,
        AstKind::NewExpression(_) => Slot::Argument,
        AstKind::TaggedTemplateExpression(expression) if is(&expression.tag) => Slot::Tag,
        AstKind::LogicalExpression(logical) if is(&logical.left) => Slot::LogicalLeft(logical.operator),
        AstKind::LogicalExpression(logical) => Slot::LogicalRight(logical.operator),
        AstKind::ConditionalExpression(expression) if is(&expression.test) => Slot::CondTest,
        AstKind::ConditionalExpression(expression) if is(&expression.consequent) => Slot::CondConsequent,
        AstKind::ConditionalExpression(_) => Slot::CondAlternate,
        AstKind::IfStatement(statement) if is(&statement.test) => Slot::Test,
        AstKind::IfStatement(statement) if is(&statement.consequent) => Slot::IfConsequent,
        AstKind::IfStatement(_) => Slot::IfAlternate,
        AstKind::WhileStatement(statement) if is(&statement.test) => Slot::Test,
        AstKind::WhileStatement(_) => Slot::LoopBody,
        AstKind::DoWhileStatement(statement) if is(&statement.test) => Slot::Test,
        AstKind::ForStatement(statement) if statement.test.as_ref().is_some_and(|test| is(test)) => Slot::Test,
        AstKind::ForStatement(statement) if is(&statement.body) => Slot::LoopBody,
        AstKind::UnaryExpression(unary) => match unary.operator {
            UnaryOperator::LogicalNot => Slot::Not,
            UnaryOperator::Typeof => Slot::Typeof,
            UnaryOperator::Void => Slot::Void,
            UnaryOperator::Delete => Slot::Delete,
            _ => Slot::Other,
        },
        AstKind::BinaryExpression(binary) => match binary.operator {
            BinaryOperator::Instanceof if is(&binary.left) => Slot::InstanceofLeft,
            BinaryOperator::Instanceof => Slot::InstanceofRight,
            BinaryOperator::In if is(&binary.right) => Slot::InRight,
            operator if operator.is_equality() || operator.is_compare() => Slot::Compare,
            _ => Slot::Other,
        },
        AstKind::SpreadElement(_) => match spread_into(nodes, nodes.parent_id(child)) {
            Some(into) => Slot::Spread { into },
            None => Slot::Other,
        },
        AstKind::ForOfStatement(statement) if is(&statement.right) => Slot::ForOfRight,
        AstKind::ForInStatement(statement) if is(&statement.right) => Slot::ForInRight,
        AstKind::ForOfStatement(statement) if is(&statement.left) => Slot::AssignTarget,
        AstKind::ForInStatement(statement) if is(&statement.left) => Slot::AssignTarget,
        AstKind::VariableDeclarator(declarator)
            if declarator.init.as_ref().is_some_and(|init| is(init)) && !declarator.id.is_binding_identifier() =>
        {
            Slot::DestructuringSource
        }
        AstKind::FormalParameter(parameter)
            if parameter
                .initializer
                .as_deref()
                .is_some_and(|initializer| is(initializer))
                && !parameter.pattern.is_binding_identifier() =>
        {
            Slot::DestructuringSource
        }
        AstKind::AssignmentPattern(pattern) if is(&pattern.right) && !pattern.left.is_binding_identifier() => {
            Slot::DestructuringSource
        }
        AstKind::AssignmentExpression(assignment) if is(&assignment.left) => Slot::AssignTarget,
        AstKind::AssignmentExpression(assignment)
            if assignment.operator == AssignmentOperator::Assign && assignment.left.is_assignment_target_pattern() =>
        {
            Slot::DestructuringSource
        }
        AstKind::AssignmentExpression(_) => Slot::AssignValue,
        AstKind::AssignmentTargetWithDefault(target) if is(&target.binding) => Slot::AssignTarget,
        AstKind::AssignmentTargetWithDefault(target) if target.binding.is_assignment_target_pattern() => {
            Slot::DestructuringSource
        }
        AstKind::ArrayAssignmentTarget(_) | AstKind::AssignmentTargetRest(_) => Slot::AssignTarget,
        // The computed key of `{ [X.m]: a }` is a read.
        AstKind::AssignmentTargetPropertyProperty(property) if is(&property.binding) => Slot::AssignTarget,
        AstKind::AwaitExpression(_) => Slot::Await,
        AstKind::YieldExpression(expression) => Slot::Yield {
            delegate: expression.delegate,
        },
        AstKind::Class(class) if class.heritage.as_ref().is_some_and(|heritage| is(&heritage.expression)) => {
            Slot::Extends
        }
        AstKind::ExpressionStatement(_) => Slot::Statement,
        AstKind::ForStatement(statement)
            if statement.init.as_ref().is_some_and(|init| is(init))
                || statement.update.as_ref().is_some_and(|update| is(update)) =>
        {
            Slot::Statement
        }
        _ => Slot::Other,
    }
}

/// The pattern that destructures a value: a declaration pattern or an assignment pattern.
pub enum Pattern<'a> {
    Binding(&'a BindingPattern<'a>),
    Target(&'a AssignmentTarget<'a>),
}

/// The pattern that destructures the value at `source`, a node in the position
/// `Slot::DestructuringSource`: `{ a }` in `const { a } = X`, `({ a } = X)`, `function f({ a } = X) {}`,
/// `[{ a } = X] = list`.
pub fn destructuring<'a>(nodes: &AstNodes<'a>, source: NodeId) -> Option<Pattern<'a>> {
    match nodes.parent_kind(source) {
        AstKind::VariableDeclarator(declarator) => Some(Pattern::Binding(&declarator.id)),
        AstKind::FormalParameter(parameter) => Some(Pattern::Binding(&parameter.pattern)),
        AstKind::AssignmentPattern(assignment) => Some(Pattern::Binding(&assignment.left)),
        AstKind::AssignmentExpression(assignment) => Some(Pattern::Target(&assignment.left)),
        AstKind::AssignmentTargetWithDefault(target) => Some(Pattern::Target(&target.binding)),
        _ => None,
    }
}

/// The global `Boolean`, also through the global object: `Boolean`, `globalThis.Boolean`.
pub fn is_boolean(semantic: &Semantic<'_>, callee: &Expression<'_>) -> bool {
    path(semantic, callee).is_some_and(|path| path == ["Boolean"])
}

/// Whether the child at `argument`, in the position `Slot::Argument`, is an argument of `Boolean(…)` or
/// `new Boolean(…)`: it becomes a boolean and is read no further.
pub fn is_boolean_argument(semantic: &Semantic<'_>, argument: NodeId) -> bool {
    match semantic.nodes().parent_kind(argument) {
        AstKind::CallExpression(call) => is_boolean(semantic, &call.callee),
        AstKind::NewExpression(call) => is_boolean(semantic, &call.callee),
        _ => false,
    }
}

/// What the spread element `spread` spreads into.
pub fn spread_into(nodes: &AstNodes<'_>, spread: NodeId) -> Option<SpreadInto> {
    match nodes.parent_kind(spread) {
        AstKind::ArrayExpression(_) => Some(SpreadInto::Array),
        AstKind::ObjectExpression(_) => Some(SpreadInto::Object),
        AstKind::CallExpression(_) | AstKind::NewExpression(_) => Some(SpreadInto::Call),
        _ => None,
    }
}

/// The node itself, or its outermost wrapper: `(X)`, `X as T`, `X!`, `X satisfies T`, `<T>X`, `X<T>`,
/// and the optional chain that ends at it.
pub fn outermost(nodes: &AstNodes<'_>, node: NodeId) -> NodeId {
    let mut id = node;
    while is_wrapper(nodes.parent_kind(id)) {
        id = nodes.parent_id(id);
    }
    id
}

/// A parent that has the value of its only child.
fn is_wrapper(kind: AstKind<'_>) -> bool {
    matches!(
        kind,
        AstKind::ParenthesizedExpression(_)
            | AstKind::TSAsExpression(_)
            | AstKind::TSSatisfiesExpression(_)
            | AstKind::TSInstantiationExpression(_)
            | AstKind::TSNonNullExpression(_)
            | AstKind::TSTypeAssertion(_)
            | AstKind::ChainExpression(_)
    )
}

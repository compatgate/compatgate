//! Feature checks in the code: `'Segmenter' in Intl`, `typeof structuredClone`, `x && x()`, an early
//! `return`, a `try` around a call, an optional call `x.m?.()` or an optional member access `x?.y`.
//! A use under a check of the same feature is not a finding. Syntax cannot be checked this way, so
//! syntax uses have no keys.

use std::collections::HashMap;

use oxc_ast::AstKind;
use oxc_ast::ast::{
    BinaryExpression, BinaryOperator, Expression, LogicalExpression, LogicalOperator, Statement, UnaryOperator,
};
use oxc_semantic::{AstNodes, NodeId, Semantic};
use oxc_span::{GetSpan, Span};

use super::{Use, WINDOW_ALIASES};

/// Finds the checks around uses. One instance serves all uses of a file, so the keys of early exits
/// in a statement list are collected once, not once per use.
pub struct Guards<'s, 'a> {
    semantic: &'s Semantic<'a>,
    /// For each statement list, by the node that holds it: every key that an early exit
    /// `if (!X) return;` checks, with the index of the first such statement.
    early_exits: HashMap<NodeId, HashMap<String, usize>>,
}

impl<'s, 'a> Guards<'s, 'a> {
    pub fn new(semantic: &'s Semantic<'a>) -> Self {
        Self {
            semantic,
            early_exits: HashMap::new(),
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
        let member_read = detectable && !called && is_member(nodes.kind(usage.node));
        if member_read && is_optional_object(nodes, usage.node) {
            return true;
        }
        let node_span = nodes.kind(usage.node).span();
        // The use is the tested value of the node that the walk comes from: `X`, `!X`, `A && X`, `X != null`.
        // The walk keeps this flag instead of searching each tested expression for the use, which made
        // long `||` chains cubic.
        let mut tested = member_read;
        let mut crossed_function = false;
        for ancestor in nodes.ancestors(usage.node) {
            let kind = ancestor.kind();
            let guarded = match kind {
                AstKind::Function(_) | AstKind::ArrowFunctionExpression(_) => {
                    crossed_function = true;
                    false
                }
                AstKind::UnaryExpression(unary) => {
                    detectable
                        && unary.operator == UnaryOperator::Typeof
                        && unary.argument.get_inner_expression().span() == node_span
                }
                AstKind::IfStatement(statement) => branch(
                    semantic,
                    usage,
                    tested,
                    &statement.test,
                    statement.consequent.span(),
                    statement.alternate.as_ref().map(GetSpan::span),
                ),
                AstKind::ConditionalExpression(expression) => branch(
                    semantic,
                    usage,
                    tested,
                    &expression.test,
                    expression.consequent.span(),
                    Some(expression.alternate.span()),
                ),
                AstKind::LogicalExpression(expression) => logical(semantic, usage, tested, expression),
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
            tested = tested && passes_tested_value(semantic, kind, node_span);
        }
        false
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
            for key in negative_keys(semantic, &check.test) {
                first_exits.entry(key).or_insert(index);
            }
        }
    }
    first_exits
}

/// Whether `kind` passes on the tested value from its child: `!X`, `A && X`, `(X)`, `X != null`.
/// A member read that the code dereferences, `X.y`, throws when `X` is missing, so it is not a check.
fn passes_tested_value(semantic: &Semantic<'_>, kind: AstKind<'_>, node_span: Span) -> bool {
    match kind {
        AstKind::ParenthesizedExpression(_)
        | AstKind::TSAsExpression(_)
        | AstKind::TSSatisfiesExpression(_)
        | AstKind::TSInstantiationExpression(_)
        | AstKind::TSNonNullExpression(_)
        | AstKind::TSTypeAssertion(_)
        | AstKind::LogicalExpression(_) => true,
        AstKind::UnaryExpression(unary) => unary.operator == UnaryOperator::LogicalNot,
        AstKind::BinaryExpression(binary) => {
            is_equality(binary.operator)
                && compared_with_undefined(semantic, binary).is_some_and(|operand| operand.span() == node_span)
        }
        _ => false,
    }
}

/// `X?.y` and `X?.m()`: optional chaining reads nothing from a missing `X`.
fn is_optional_object(nodes: &AstNodes<'_>, node: NodeId) -> bool {
    let mut id = node;
    while matches!(
        nodes.parent_kind(id),
        AstKind::ParenthesizedExpression(_)
            | AstKind::TSAsExpression(_)
            | AstKind::TSNonNullExpression(_)
            | AstKind::TSSatisfiesExpression(_)
            | AstKind::TSTypeAssertion(_)
    ) {
        id = nodes.parent_id(id);
    }
    let span = nodes.kind(id).span();
    match nodes.parent_kind(id) {
        AstKind::StaticMemberExpression(member) => member.optional && member.object.span() == span,
        AstKind::ComputedMemberExpression(member) => member.optional && member.object.span() == span,
        _ => false,
    }
}

/// The call whose callee is the use, or the use itself when it is a call: `(optional, callee is a member)`.
fn enclosing_call(nodes: &AstNodes<'_>, usage: &Use) -> Option<(bool, bool)> {
    let describe = |callee: &Expression<'_>, optional: bool| {
        (
            optional,
            matches!(
                callee.get_inner_expression(),
                Expression::StaticMemberExpression(_) | Expression::ComputedMemberExpression(_)
            ),
        )
    };
    match nodes.kind(usage.node) {
        AstKind::CallExpression(call) => return Some(describe(&call.callee, call.optional)),
        AstKind::NewExpression(expression) => return Some(describe(&expression.callee, false)),
        _ => {}
    }
    match nodes.parent_kind(usage.node) {
        AstKind::CallExpression(call) if call.callee.span() == usage.span => {
            Some(describe(&call.callee, call.optional))
        }
        AstKind::NewExpression(expression) if expression.callee.span() == usage.span => {
            Some(describe(&expression.callee, false))
        }
        _ => None,
    }
}

fn is_member(kind: AstKind<'_>) -> bool {
    matches!(
        kind,
        AstKind::StaticMemberExpression(_) | AstKind::ComputedMemberExpression(_)
    )
}

fn branch(
    semantic: &Semantic<'_>,
    usage: &Use,
    tested: bool,
    test: &Expression<'_>,
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
        return matches(usage, &positive_keys(semantic, test));
    }
    alternate.is_some_and(|alternate| within(alternate, usage.span) && matches(usage, &negative_keys(semantic, test)))
}

fn logical(semantic: &Semantic<'_>, usage: &Use, tested: bool, expression: &LogicalExpression<'_>) -> bool {
    if usage.keys.is_empty() {
        return false;
    }
    if within(expression.left.span(), usage.span) {
        return tested;
    }
    within(expression.right.span(), usage.span)
        && match expression.operator {
            LogicalOperator::And => matches(usage, &positive_keys(semantic, &expression.left)),
            LogicalOperator::Or => matches(usage, &negative_keys(semantic, &expression.left)),
            LogicalOperator::Coalesce => false,
        }
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

/// Features that are present when `test` is true.
fn positive_keys(semantic: &Semantic<'_>, test: &Expression<'_>) -> Vec<String> {
    match test.get_inner_expression() {
        Expression::UnaryExpression(unary) if unary.operator == UnaryOperator::LogicalNot => {
            negative_keys(semantic, &unary.argument)
        }
        Expression::LogicalExpression(logical) if logical.operator == LogicalOperator::And => {
            let mut keys = positive_keys(semantic, &logical.left);
            keys.extend(positive_keys(semantic, &logical.right));
            keys
        }
        Expression::BinaryExpression(binary) => match binary.operator {
            BinaryOperator::In => in_keys(binary),
            BinaryOperator::LessThan | BinaryOperator::GreaterThan => minified_typeof_keys(binary, true),
            BinaryOperator::Inequality | BinaryOperator::StrictInequality => {
                let mut keys = typeof_keys(binary, |kind| kind == "undefined");
                keys.extend(undefined_keys(semantic, binary));
                keys
            }
            BinaryOperator::Equality | BinaryOperator::StrictEquality => {
                typeof_keys(binary, |kind| kind == "function" || kind == "object")
            }
            _ => Vec::new(),
        },
        other => chain_keys(other),
    }
}

/// Features that are present when `test` is false.
fn negative_keys(semantic: &Semantic<'_>, test: &Expression<'_>) -> Vec<String> {
    match test.get_inner_expression() {
        Expression::UnaryExpression(unary) if unary.operator == UnaryOperator::LogicalNot => {
            positive_keys(semantic, &unary.argument)
        }
        Expression::LogicalExpression(logical) if logical.operator == LogicalOperator::Or => {
            let mut keys = negative_keys(semantic, &logical.left);
            keys.extend(negative_keys(semantic, &logical.right));
            keys
        }
        Expression::BinaryExpression(binary) => match binary.operator {
            BinaryOperator::LessThan | BinaryOperator::GreaterThan => minified_typeof_keys(binary, false),
            BinaryOperator::Equality | BinaryOperator::StrictEquality => {
                let mut keys = typeof_keys(binary, |kind| kind == "undefined");
                keys.extend(undefined_keys(semantic, binary));
                keys
            }
            BinaryOperator::Inequality | BinaryOperator::StrictInequality => {
                typeof_keys(binary, |kind| kind == "function" || kind == "object")
            }
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

/// `'name' in object`.
fn in_keys(binary: &BinaryExpression<'_>) -> Vec<String> {
    let Expression::StringLiteral(name) = binary.left.get_inner_expression() else {
        return Vec::new();
    };
    let Some(object) = chain(&binary.right) else {
        return Vec::new();
    };
    let name = name.value.as_str();
    vec![join(&object, name), format!("#{name}")]
}

/// `typeof chain === 'kind'` in either order.
fn typeof_keys(binary: &BinaryExpression<'_>, accept: impl Fn(&str) -> bool) -> Vec<String> {
    let (unary, literal) = match (binary.left.get_inner_expression(), binary.right.get_inner_expression()) {
        (Expression::UnaryExpression(unary), Expression::StringLiteral(literal))
        | (Expression::StringLiteral(literal), Expression::UnaryExpression(unary)) => (unary, literal),
        _ => return Vec::new(),
    };
    if unary.operator != UnaryOperator::Typeof || !accept(literal.value.as_str()) {
        return Vec::new();
    }
    chain_keys(&unary.argument)
}

fn chain_keys(expression: &Expression<'_>) -> Vec<String> {
    let Some(chain) = chain(expression) else {
        return Vec::new();
    };
    let method = chain.rsplit_once('.').map(|(_, last)| format!("#{last}"));
    std::iter::once(chain).chain(method).collect()
}

/// `a.b['c']` as `a.b.c`. `window.X` is `X`.
fn chain(expression: &Expression<'_>) -> Option<String> {
    match expression.get_inner_expression() {
        Expression::Identifier(identifier) => Some(identifier.name.as_str().to_string()),
        Expression::StaticMemberExpression(member) => {
            Some(join(&chain(&member.object)?, member.property.name.as_str()))
        }
        Expression::ComputedMemberExpression(member) => match member.expression.get_inner_expression() {
            Expression::StringLiteral(name) => Some(join(&chain(&member.object)?, name.value.as_str())),
            _ => None,
        },
        _ => None,
    }
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
fn minified_typeof_keys(binary: &BinaryExpression<'_>, present: bool) -> Vec<String> {
    let is_u = |expression: &Expression<'_>| matches!(expression.get_inner_expression(), Expression::StringLiteral(literal) if literal.value == "u");
    let typeof_argument = |expression: &Expression<'_>| match expression.get_inner_expression() {
        Expression::UnaryExpression(unary) if unary.operator == UnaryOperator::Typeof => {
            Some(chain_keys(&unary.argument))
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
/// `null`. `undefined == null`, but `undefined !== null`. Member chains only: a bare global compared
/// to `undefined` throws when it is missing.
fn compared_with_undefined<'b, 'a>(
    semantic: &Semantic<'_>,
    binary: &'b BinaryExpression<'a>,
) -> Option<&'b Expression<'a>> {
    let loose = matches!(binary.operator, BinaryOperator::Equality | BinaryOperator::Inequality);
    let is_undefined = |expression: &Expression<'_>| match expression.get_inner_expression() {
        Expression::NullLiteral(_) => loose,
        Expression::UnaryExpression(unary) => unary.operator == UnaryOperator::Void,
        Expression::Identifier(identifier) => {
            identifier.name == "undefined"
                && semantic
                    .scoping()
                    .get_reference(identifier.reference_id())
                    .symbol_id()
                    .is_none()
        }
        _ => false,
    };
    let operand = if is_undefined(&binary.right) {
        &binary.left
    } else if is_undefined(&binary.left) {
        &binary.right
    } else {
        return None;
    };
    matches!(
        operand.get_inner_expression(),
        Expression::StaticMemberExpression(_) | Expression::ComputedMemberExpression(_)
    )
    .then_some(operand)
}

/// `X !== undefined`, `void 0 !== X`, `X != null` and the `==` forms. Callers pick the sign by operator.
fn undefined_keys(semantic: &Semantic<'_>, binary: &BinaryExpression<'_>) -> Vec<String> {
    compared_with_undefined(semantic, binary)
        .map(chain_keys)
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

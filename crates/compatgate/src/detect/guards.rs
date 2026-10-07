//! Feature checks in the code: `'Segmenter' in Intl`, `typeof structuredClone`, `x && x()`, an early
//! `return`, a `try` around a call, an optional call `x.m?.()`. A use under a check of the same
//! feature is not a finding. Syntax cannot be checked this way, so syntax uses have no keys.

use oxc_ast::AstKind;
use oxc_ast::ast::{
    BinaryExpression, BinaryOperator, Expression, LogicalExpression, LogicalOperator, Statement, UnaryOperator,
};
use oxc_semantic::{AstNodes, Semantic};
use oxc_span::{GetSpan, Span};

use super::{Use, WINDOW_ALIASES};

pub fn is_guarded(semantic: &Semantic<'_>, usage: &Use) -> bool {
    let nodes = semantic.nodes();
    let span = usage.span;
    let call = enclosing_call(nodes, usage);
    if usage.catchable && call.is_some_and(|(optional, callee_is_member)| optional && callee_is_member) {
        return true;
    }
    let called = call.is_some();
    let detectable = !usage.keys.is_empty();
    // Reading a member returns `undefined` when the feature is missing, so the read is the check itself.
    // A bare global throws `ReferenceError` instead, so reading it is a use.
    let member_read = detectable && !called && is_member(nodes.kind(usage.node));
    let node_span = nodes.kind(usage.node).span();
    let tested = |expression: &Expression<'_>| member_read && is_tested_operand(semantic, expression, node_span);
    let mut crossed_function = false;
    for ancestor in nodes.ancestors(usage.node) {
        let guarded = match ancestor.kind() {
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
                &tested,
                &statement.test,
                statement.consequent.span(),
                statement.alternate.as_ref().map(GetSpan::span),
            ),
            AstKind::ConditionalExpression(expression) => branch(
                semantic,
                usage,
                &tested,
                &expression.test,
                expression.consequent.span(),
                Some(expression.alternate.span()),
            ),
            AstKind::LogicalExpression(expression) => logical(semantic, usage, &tested, expression),
            AstKind::TryStatement(statement) => {
                // A `try` does not reach into a callback: it runs after the `try` has finished.
                usage.catchable
                    && called
                    && !crossed_function
                    && statement.handler.is_some()
                    && within(statement.block.span, span)
            }
            AstKind::BlockStatement(block) => detectable && after_early_exit(semantic, &block.body, usage),
            AstKind::FunctionBody(body) => detectable && after_early_exit(semantic, &body.statements, usage),
            AstKind::Program(program) => detectable && after_early_exit(semantic, &program.body, usage),
            AstKind::SwitchCase(case) => detectable && after_early_exit(semantic, &case.consequent, usage),
            AstKind::StaticBlock(block) => detectable && after_early_exit(semantic, &block.body, usage),
            _ => false,
        };
        if guarded {
            return true;
        }
    }
    false
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
    tested: &dyn Fn(&Expression<'_>) -> bool,
    test: &Expression<'_>,
    consequent: Span,
    alternate: Option<Span>,
) -> bool {
    if usage.keys.is_empty() {
        return false;
    }
    if within(test.span(), usage.span) {
        return tested(test);
    }
    if within(consequent, usage.span) {
        return matches(usage, &positive_keys(semantic, test));
    }
    alternate.is_some_and(|alternate| within(alternate, usage.span) && matches(usage, &negative_keys(semantic, test)))
}

fn logical(
    semantic: &Semantic<'_>,
    usage: &Use,
    tested: &dyn Fn(&Expression<'_>) -> bool,
    expression: &LogicalExpression<'_>,
) -> bool {
    if usage.keys.is_empty() {
        return false;
    }
    if within(expression.left.span(), usage.span) {
        return tested(&expression.left);
    }
    within(expression.right.span(), usage.span)
        && match expression.operator {
            LogicalOperator::And => matches(usage, &positive_keys(semantic, &expression.left)),
            LogicalOperator::Or => matches(usage, &negative_keys(semantic, &expression.left)),
            LogicalOperator::Coalesce => false,
        }
}

/// `if (!X) return;` before the use, in the same statement list.
fn after_early_exit(semantic: &Semantic<'_>, statements: &[Statement<'_>], usage: &Use) -> bool {
    let Some(position) = statements
        .iter()
        .position(|statement| within(statement.span(), usage.span))
    else {
        return false;
    };
    statements[..position].iter().any(|statement| match statement {
        Statement::IfStatement(check) => {
            check.alternate.is_none()
                && exits(&check.consequent)
                && matches(usage, &negative_keys(semantic, &check.test))
        }
        _ => false,
    })
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

/// The use is the tested operand itself: `if (X)`, `!X`, `A && X`. A member read that the code
/// dereferences, `X.y`, throws when `X` is missing, so it is not a check.
fn is_tested_operand(semantic: &Semantic<'_>, expression: &Expression<'_>, node_span: Span) -> bool {
    match expression.get_inner_expression() {
        Expression::UnaryExpression(unary) if unary.operator == UnaryOperator::LogicalNot => {
            is_tested_operand(semantic, &unary.argument, node_span)
        }
        Expression::LogicalExpression(logical) => {
            is_tested_operand(semantic, &logical.left, node_span)
                || is_tested_operand(semantic, &logical.right, node_span)
        }
        Expression::BinaryExpression(binary) if is_equality(binary.operator) => {
            compared_with_undefined(semantic, binary).is_some_and(|operand| operand.span() == node_span)
        }
        other => other.span() == node_span,
    }
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

/// The member chain that `binary` compares with `undefined` or `void 0`. Member chains only: a bare
/// global compared to `undefined` throws when it is missing.
fn compared_with_undefined<'b, 'a>(
    semantic: &Semantic<'_>,
    binary: &'b BinaryExpression<'a>,
) -> Option<&'b Expression<'a>> {
    let is_undefined = |expression: &Expression<'_>| match expression.get_inner_expression() {
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

/// `X !== undefined`, `void 0 !== X` and the `!=` forms. Callers pick the sign by operator.
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

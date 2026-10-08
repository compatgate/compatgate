//! Member paths: `a.b['c']`, `a?.b.c` and `(a).b!` are the path `a.b.c`. Detectors name a use by its
//! path, and the guards name a checked feature the same way, so both sides agree on wrappers, optional
//! chains, string keys and the aliases of the global object.

use oxc_ast::AstKind;
use oxc_ast::ast::{
    ChainElement, ComputedMemberExpression, Expression, IdentifierReference, MemberExpression, PropertyKey,
};
use oxc_semantic::{AstNodes, NodeId, Semantic};
use oxc_span::Span;

use super::slot::{Slot, outermost, slot};

/// Names under which the global object is reachable. `window.X` is the global `X`.
pub const WINDOW_ALIASES: [&str; 3] = ["window", "self", "globalThis"];

/// A reference that resolves to no declaration in the file.
pub fn is_global(semantic: &Semantic<'_>, identifier: &IdentifierReference<'_>) -> bool {
    semantic
        .scoping()
        .get_reference(identifier.reference_id())
        .symbol_id()
        .is_none()
}

/// The member expression in `expression`, through wrappers and an optional chain.
pub fn as_member<'b, 'a>(expression: &'b Expression<'a>) -> Option<&'b MemberExpression<'a>> {
    match expression.get_inner_expression() {
        Expression::ChainExpression(chain) => match &chain.expression {
            ChainElement::TSNonNullExpression(non_null) => as_member(&non_null.expression),
            element => element.as_member_expression(),
        },
        other => other.as_member_expression(),
    }
}

/// The name of a member: `b` in `a.b` and in `a['b']`. `None` for another computed key and for `a.#b`.
pub fn property<'a>(member: &MemberExpression<'a>) -> Option<&'a str> {
    match member {
        MemberExpression::StaticMemberExpression(member) => Some(member.property.name.as_str()),
        MemberExpression::ComputedMemberExpression(member) => computed_name(member),
        MemberExpression::PrivateFieldExpression(_) => None,
    }
}

/// `b` in `a['b']`: the key when it is a string.
fn computed_name<'a>(member: &ComputedMemberExpression<'a>) -> Option<&'a str> {
    match member.expression.get_inner_expression() {
        Expression::StringLiteral(name) => Some(name.value.as_str()),
        _ => None,
    }
}

/// The name of a property key: `take` in `take() {}`, `take: f`, `'take': f` and `['take']: f`.
pub fn key_name<'a>(key: &PropertyKey<'a>) -> Option<&'a str> {
    match key {
        PropertyKey::StaticIdentifier(identifier) => Some(identifier.name.as_str()),
        PropertyKey::StringLiteral(literal) => Some(literal.value.as_str()),
        _ => None,
    }
}

/// The path of `expression` from a global reference: `["navigator", "share"]` for `navigator.share`.
/// Leading aliases of the global object are dropped, so `window.navigator.share` has the same path,
/// and a bare `window` stays `["window"]`. `None` when the root is not a global reference or a key is
/// not static.
pub fn path<'a>(semantic: &Semantic<'_>, expression: &Expression<'a>) -> Option<Vec<&'a str>> {
    let mut segments = Vec::new();
    let mut current = expression;
    let root = loop {
        if let Expression::Identifier(identifier) = current.get_inner_expression() {
            break identifier;
        }
        let member = as_member(current)?;
        segments.push(property(member)?);
        current = member.object();
    };
    if !is_global(semantic, root) {
        return None;
    }
    segments.push(root.name.as_str());
    segments.reverse();
    drop_aliases(&mut segments);
    Some(segments)
}

/// The path of `object.name`: `["Intl", "Segmenter"]` for `Intl` and `Segmenter`, `["share"]` for
/// `window` and `share`.
pub fn member_path<'a>(semantic: &Semantic<'_>, object: &Expression<'a>, name: &'a str) -> Option<Vec<&'a str>> {
    let mut segments = path(semantic, object)?;
    segments.push(name);
    drop_aliases(&mut segments);
    Some(segments)
}

/// Drops the leading aliases of the global object, but keeps the last segment.
fn drop_aliases(segments: &mut Vec<&str>) {
    let aliases = segments
        .iter()
        .take_while(|segment| WINDOW_ALIASES.contains(segment))
        .count()
        .min(segments.len().saturating_sub(1));
    segments.drain(..aliases);
}

/// The expression at the root of a member chain: `a` in `a.b['c']` and in `(a?.b).c`.
pub fn root<'b, 'a>(expression: &'b Expression<'a>) -> &'b Expression<'a> {
    let mut current = expression.get_inner_expression();
    while let Some(member) = as_member(current) {
        current = member.object().get_inner_expression();
    }
    current
}

/// A member read around an object.
pub struct Member<'a> {
    pub id: NodeId,
    pub span: Span,
    pub property: &'a str,
}

/// `X.member` or `X['member']` around the expression `X` at `node`, which may be wrapped.
pub fn member_over<'a>(nodes: &AstNodes<'a>, node: NodeId) -> Option<Member<'a>> {
    let object = outermost(nodes, node);
    member_at(nodes, object, slot(nodes, object))
}

/// The member read whose object is `object` in the position `position`.
pub fn member_at<'a>(nodes: &AstNodes<'a>, object: NodeId, position: Slot) -> Option<Member<'a>> {
    if !matches!(position, Slot::Object { .. }) {
        return None;
    }
    let id = nodes.parent_id(object);
    let (span, property) = match nodes.kind(id) {
        AstKind::StaticMemberExpression(member) => (member.span, member.property.name.as_str()),
        AstKind::ComputedMemberExpression(member) => (member.span, computed_name(member)?),
        _ => return None,
    };
    Some(Member { id, span, property })
}

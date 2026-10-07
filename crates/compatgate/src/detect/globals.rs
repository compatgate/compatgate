//! Uses of global objects, constructors and functions: `structuredClone()`, `new Intl.Segmenter()`,
//! `window.structuredClone`, `navigator.userActivation`. Only references that resolve to no declared
//! binding count, so a local `structuredClone` is ignored.

use oxc_ast::AstKind;
use oxc_ast::ast::Expression;
use oxc_semantic::{AstNodes, NodeId, Semantic};
use oxc_span::{GetSpan, Span};

use super::{Use, WINDOW_ALIASES};
use crate::check::Kind;
use crate::data::{FeatureId, singleton_interface};

pub fn detect(semantic: &Semantic<'_>) -> Vec<Use> {
    let scoping = semantic.scoping();
    let nodes = semantic.nodes();
    let mut uses = Vec::new();
    for (name, references) in scoping.root_unresolved_references().iter() {
        let name = name.as_str();
        for &reference_id in references.iter() {
            let reference = scoping.get_reference(reference_id);
            // A type position such as `let o: ResizeObserver` does not use the API at run time.
            if !reference.is_value() {
                continue;
            }
            // `structuredClone = polyfill` defines the global; it does not use it.
            if reference.is_write() && !reference.is_read() {
                continue;
            }
            let node_id = reference.node_id();
            let AstKind::IdentifierReference(identifier) = nodes.kind(node_id) else {
                continue;
            };
            let is_alias = WINDOW_ALIASES.contains(&name);
            let first = member_of(nodes, node_id);
            if let Some(first) = &first {
                // `window.structuredClone = polyfill` and `Object.groupBy = polyfill` define a member.
                if is_assignment_target(nodes, first) {
                    continue;
                }
                if is_alias {
                    // `window.navigator.userActivation` resolves like `navigator.userActivation`.
                    if let Some(second) = member_of(nodes, first.id) {
                        if is_assignment_target(nodes, &second) {
                            continue;
                        }
                        if let Some(usage) = member_use(&first.property, &second) {
                            uses.push(usage);
                            continue;
                        }
                    }
                    if let Some(feature) = global_feature(&first.property, is_new_callee(nodes, first)) {
                        uses.push(
                            Use::new(feature, kind_of(feature), first.span, first.id)
                                .with_keys(vec![first.property.clone()]),
                        );
                    }
                    continue;
                }
                if let Some(usage) = member_use(name, first) {
                    uses.push(usage);
                    continue;
                }
            }
            // A bare `window` or `self` is not a use of a feature.
            if is_alias {
                continue;
            }
            let (outer_id, outer_span) = outermost(nodes, node_id);
            let is_new =
                matches!(nodes.parent_kind(outer_id), AstKind::NewExpression(e) if e.callee.span() == outer_span);
            if let Some(feature) = global_feature(name, is_new) {
                uses.push(
                    Use::new(feature, kind_of(feature), identifier.span, node_id).with_keys(vec![name.to_string()]),
                );
            }
        }
    }
    uses
}

struct Member {
    id: NodeId,
    span: Span,
    property: String,
}

/// The node itself, or its outermost wrapper: `(X)`, `X as T`, `X!`, `X satisfies T`, `<T>X`.
fn outermost(nodes: &AstNodes<'_>, node_id: NodeId) -> (NodeId, Span) {
    let mut id = node_id;
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
    (id, nodes.kind(id).span())
}

/// `X.member` or `X['member']` around the expression `X`, which may be wrapped.
fn member_of(nodes: &AstNodes<'_>, node_id: NodeId) -> Option<Member> {
    let (outer_id, object) = outermost(nodes, node_id);
    let parent_id = nodes.parent_id(outer_id);
    match nodes.kind(parent_id) {
        AstKind::StaticMemberExpression(member) if member.object.span() == object => Some(Member {
            id: parent_id,
            span: member.span,
            property: member.property.name.as_str().to_string(),
        }),
        AstKind::ComputedMemberExpression(member) if member.object.span() == object => {
            match member.expression.get_inner_expression() {
                Expression::StringLiteral(name) => Some(Member {
                    id: parent_id,
                    span: member.span,
                    property: name.value.as_str().to_string(),
                }),
                _ => None,
            }
        }
        _ => None,
    }
}

fn member_use(object: &str, member: &Member) -> Option<Use> {
    let property = member.property.as_str();
    let feature = match singleton_interface(object) {
        Some(interface) => FeatureId::find(&format!("api.{interface}.{property}")),
        None => member_feature(object, property),
    }?;
    Some(Use::new(feature, kind_of(feature), member.span, member.id).with_keys(vec![format!("{object}.{property}")]))
}

fn is_assignment_target(nodes: &AstNodes<'_>, member: &Member) -> bool {
    let (outer_id, span) = outermost(nodes, member.id);
    matches!(nodes.parent_kind(outer_id), AstKind::AssignmentExpression(a) if a.left.span() == span)
}

fn is_new_callee(nodes: &AstNodes<'_>, member: &Member) -> bool {
    let (outer_id, span) = outermost(nodes, member.id);
    matches!(nodes.parent_kind(outer_id), AstKind::NewExpression(e) if e.callee.span() == span)
}

/// `Object.groupBy`, `Intl.Segmenter`, `BarcodeDetector.getSupportedFormats`.
/// BCD marks static members of Web API interfaces with a `_static` suffix.
fn member_feature(object: &str, member: &str) -> Option<FeatureId> {
    [
        format!("javascript.builtins.{object}.{member}"),
        format!("api.{object}.{member}_static"),
        format!("api.{object}.{member}"),
    ]
    .iter()
    .find_map(|id| FeatureId::find(id))
}

/// A bare global. For `new X()` the constructor entry `api.X.X` is more precise than the interface.
fn global_feature(name: &str, is_new: bool) -> Option<FeatureId> {
    let constructor = is_new.then(|| format!("api.{name}.{name}"));
    constructor
        .into_iter()
        .chain([
            format!("javascript.builtins.{name}"),
            format!("api.{name}"),
            format!("api.Window.{name}"),
        ])
        .find_map(|id| FeatureId::find(&id))
}

pub(crate) fn kind_of(feature: FeatureId) -> Kind {
    if feature.as_str().starts_with("api.") {
        Kind::Api
    } else {
        Kind::Builtin
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::check::with_semantic;

    fn detected(source: &str) -> Vec<(&'static str, Vec<String>)> {
        detected_in(source, "a.js")
    }

    fn detected_in(source: &str, filename: &str) -> Vec<(&'static str, Vec<String>)> {
        with_semantic(source, filename, |semantic, _| {
            detect(semantic)
                .into_iter()
                .map(|usage| (usage.feature.as_str(), usage.keys))
                .collect()
        })
        .unwrap()
    }

    fn features(source: &str) -> Vec<&'static str> {
        detected(source).into_iter().map(|(feature, _)| feature).collect()
    }

    #[test]
    fn members_of_window_aliases_are_globals() {
        assert_eq!(
            detected("window.structuredClone(1);"),
            [("api.structuredClone", vec!["structuredClone".to_string()])]
        );
        assert_eq!(
            features("self.structuredClone(1); globalThis.structuredClone(2);"),
            ["api.structuredClone"; 2]
        );
        assert_eq!(
            features("new window.ResizeObserver(cb);"),
            ["api.ResizeObserver.ResizeObserver"]
        );
    }

    #[test]
    fn members_of_singletons_resolve_to_their_interface() {
        assert_eq!(
            detected("navigator.userActivation.isActive;"),
            [(
                "api.Navigator.userActivation",
                vec!["navigator.userActivation".to_string()]
            )]
        );
    }

    #[test]
    fn computed_access_with_a_string_is_a_member() {
        assert_eq!(
            features("Object['groupBy']([], x => x);"),
            ["javascript.builtins.Object.groupBy"]
        );
    }

    #[test]
    fn defining_a_global_is_not_a_use() {
        assert!(features("structuredClone = function () {};").is_empty());
        assert!(features("window.structuredClone = function () {};").is_empty());
        assert!(features("Object.groupBy = function () {};").is_empty());
    }

    #[test]
    fn chains_through_a_window_alias_keep_the_member() {
        assert_eq!(
            detected("window.navigator.userActivation.isActive;"),
            [(
                "api.Navigator.userActivation",
                vec!["navigator.userActivation".to_string()]
            )]
        );
        assert_eq!(
            features("new globalThis.Intl.Segmenter();"),
            ["javascript.builtins.Intl.Segmenter"]
        );
    }

    #[test]
    fn wrapped_objects_resolve_to_the_member() {
        let ts = detected_in("(window as any).structuredClone(1);", "a.ts");
        assert_eq!(ts.iter().map(|(f, _)| *f).collect::<Vec<_>>(), ["api.structuredClone"]);
        assert_eq!(
            features("(navigator).userActivation;"),
            ["api.Navigator.userActivation"]
        );
    }

    #[test]
    fn unresolved_window_members_and_bare_aliases_are_not_uses() {
        assert!(features("window.noSuchThing; self;").is_empty());
        assert!(features("window.navigator.userActivation = x;").is_empty());
    }
}

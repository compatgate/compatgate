//! Uses of global objects, constructors and functions: `structuredClone()`, `new Intl.Segmenter()`,
//! `window.structuredClone`, `navigator.userActivation`, `const { groupBy } = Object`. Only references
//! that resolve to no declared binding count, so a local `structuredClone` is ignored.

use std::borrow::Cow;

use oxc_ast::AstKind;
use oxc_ast::ast::{
    AssignmentOperator, AssignmentTarget, AssignmentTargetProperty, BindingPattern, Expression, UnaryOperator,
};
use oxc_semantic::{AstNodes, NodeId, Semantic};
use oxc_span::{GetSpan, Span};

use super::{Use, WINDOW_ALIASES};
use crate::check::Kind;
use crate::data::{FeatureId, interface_parents, singleton_interface};

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
            if let Some(first) = member_of(nodes, node_id) {
                // `window.structuredClone = polyfill` and `Object.groupBy = polyfill` define a member.
                if is_written_or_deleted(nodes, &first) {
                    continue;
                }
                if is_alias {
                    // `window.navigator.userActivation` resolves like `navigator.userActivation`.
                    if let Some(second) = member_of(nodes, first.id) {
                        if is_written_or_deleted(nodes, &second) {
                            continue;
                        }
                        if let Some(usage) = member_use(&first.property, &second) {
                            uses.push(usage);
                            continue;
                        }
                    }
                    uses.extend(global_member_use(&first, is_new_callee(nodes, &first)));
                    continue;
                }
                if let Some(usage) = member_use(name, &first) {
                    uses.push(usage);
                    continue;
                }
            } else {
                // `const { groupBy } = Object` reads `Object.groupBy`, as the member access does.
                let found = uses.len();
                for member in destructured(nodes, node_id) {
                    uses.extend(if is_alias {
                        global_member_use(&member, false)
                    } else {
                        member_use(name, &member)
                    });
                }
                if uses.len() > found {
                    continue;
                }
            }
            // A bare `window` or `self` is not a use of a feature.
            if is_alias {
                continue;
            }
            let (outer_id, outer_span) = outermost(nodes, node_id);
            let parent = nodes.parent_kind(outer_id);
            if matches!(parent, AstKind::UnaryExpression(e) if e.operator == UnaryOperator::Delete) {
                continue;
            }
            let is_new = matches!(parent, AstKind::NewExpression(e) if e.callee.span() == outer_span);
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

/// The properties that a destructuring takes from the expression `X`: `const { a, b: c } = X`,
/// `({ a } = X)`, `function f({ a } = X) {}`, `[{ a } = X] = list`. A computed key names a member
/// only when it is a literal, as in `X['a']`.
fn destructured(nodes: &AstNodes<'_>, node_id: NodeId) -> Vec<Member> {
    let (outer_id, span) = outermost(nodes, node_id);
    let is_source = |init: &Expression<'_>| init.span() == span;
    match nodes.parent_kind(outer_id) {
        AstKind::VariableDeclarator(declarator) if declarator.init.as_ref().is_some_and(is_source) => {
            pattern_members(&declarator.id)
        }
        AstKind::FormalParameter(parameter) if parameter.initializer.as_deref().is_some_and(is_source) => {
            pattern_members(&parameter.pattern)
        }
        AstKind::AssignmentPattern(assignment) if is_source(&assignment.right) => pattern_members(&assignment.left),
        AstKind::AssignmentExpression(assignment)
            if assignment.operator == AssignmentOperator::Assign && is_source(&assignment.right) =>
        {
            target_members(&assignment.left)
        }
        AstKind::AssignmentTargetWithDefault(target) if is_source(&target.init) => target_members(&target.binding),
        _ => Vec::new(),
    }
}

/// The properties of a declaration pattern `{ a, b: c }`.
fn pattern_members(pattern: &BindingPattern<'_>) -> Vec<Member> {
    let BindingPattern::ObjectPattern(pattern) = pattern else {
        return Vec::new();
    };
    pattern
        .properties
        .iter()
        .filter_map(|property| {
            Some(Member {
                id: property.node_id(),
                span: property.span,
                property: property.key.static_name()?.into_owned(),
            })
        })
        .collect()
}

/// The properties of an assignment pattern `({ a, b: c } = X)`.
fn target_members(target: &AssignmentTarget<'_>) -> Vec<Member> {
    let AssignmentTarget::ObjectAssignmentTarget(target) = target else {
        return Vec::new();
    };
    target
        .properties
        .iter()
        .filter_map(|property| {
            let (id, span, name) = match property {
                AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(property) => (
                    property.node_id(),
                    property.span,
                    Cow::Borrowed(property.binding.name.as_str()),
                ),
                AssignmentTargetProperty::AssignmentTargetPropertyProperty(property) => {
                    (property.node_id(), property.span, property.name.static_name()?)
                }
            };
            Some(Member {
                id,
                span,
                property: name.into_owned(),
            })
        })
        .collect()
}

fn member_use(object: &str, member: &Member) -> Option<Use> {
    let property = member.property.as_str();
    let feature = match singleton_interface(object) {
        Some(interface) => interface_member(interface, property),
        None => member_feature(object, property),
    }?;
    Some(Use::new(feature, kind_of(feature), member.span, member.id).with_keys(vec![format!("{object}.{property}")]))
}

/// A member of the global object, `window.structuredClone`. Code checks it as the bare global.
fn global_member_use(member: &Member, is_new: bool) -> Option<Use> {
    let feature = global_feature(&member.property, is_new)?;
    Some(Use::new(feature, kind_of(feature), member.span, member.id).with_keys(vec![member.property.clone()]))
}

/// `api.{Interface}.{member}`, or the entry of the nearest parent interface: `document.addEventListener`
/// is `api.EventTarget.addEventListener`. The walk is breadth-first, so an own entry wins. Parents can
/// be mixins without BCD entries, and two parents can share a parent, so each interface is visited once.
fn interface_member(interface: &'static str, member: &str) -> Option<FeatureId> {
    let mut queue = vec![interface];
    let mut next = 0;
    while let Some(&current) = queue.get(next) {
        next += 1;
        if let Some(feature) = FeatureId::find(&format!("api.{current}.{member}")) {
            return Some(feature);
        }
        for &parent in interface_parents(current) {
            if !queue.contains(&parent) {
                queue.push(parent);
            }
        }
    }
    None
}

/// The member is a target that the code writes or deletes, not a value that it reads:
/// `X.m = v`, `[X.m] = a`, `({ a: X.m = d } = o)`, `for (X.m of list)`, `delete X.m`.
fn is_written_or_deleted(nodes: &AstNodes<'_>, member: &Member) -> bool {
    let (mut outer_id, mut span) = outermost(nodes, member.id);
    // `delete window?.structuredClone`: the optional chain ends at the member, and `delete` is outside it.
    if matches!(nodes.parent_kind(outer_id), AstKind::ChainExpression(_)) {
        (outer_id, span) = outermost(nodes, nodes.parent_id(outer_id));
    }
    match nodes.parent_kind(outer_id) {
        AstKind::AssignmentExpression(assignment) => assignment.left.span() == span,
        AstKind::ArrayAssignmentTarget(_) | AstKind::AssignmentTargetRest(_) => true,
        AstKind::AssignmentTargetWithDefault(target) => target.binding.span() == span,
        // The computed key of `{ [X.m]: a }` is a read.
        AstKind::AssignmentTargetPropertyProperty(property) => property.binding.span() == span,
        AstKind::ForInStatement(statement) => statement.left.span() == span,
        AstKind::ForOfStatement(statement) => statement.left.span() == span,
        AstKind::UnaryExpression(unary) => unary.operator == UnaryOperator::Delete,
        _ => false,
    }
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

    #[test]
    fn destructuring_writes_are_not_uses() {
        let writes = [
            "[window.structuredClone] = a;",
            "[...window.structuredClone] = a;",
            "[window.structuredClone = f] = a;",
            "({ a: Object.groupBy } = o);",
            "({ a: Object.groupBy = f } = o);",
            "({ ...Object.groupBy } = o);",
            "for (window.structuredClone of list) {}",
            "for (Object.groupBy in o) {}",
            "[window.navigator.userActivation] = a;",
        ];
        for source in writes {
            assert!(features(source).is_empty(), "{source}");
        }
    }

    #[test]
    fn reads_inside_a_destructuring_target_are_uses() {
        assert_eq!(features("[a = window.structuredClone] = b;"), ["api.structuredClone"]);
        assert_eq!(
            features("({ [Object.groupBy]: a } = o);"),
            ["javascript.builtins.Object.groupBy"]
        );
        assert_eq!(
            features("for (a of Object.groupBy(b, f)) {}"),
            ["javascript.builtins.Object.groupBy"]
        );
    }

    #[test]
    fn deleting_a_global_is_not_a_use() {
        assert!(features("delete window.structuredClone;").is_empty());
        assert!(features("delete Object.groupBy;").is_empty());
        assert!(features("delete window.navigator.userActivation;").is_empty());
        assert!(features("delete structuredClone;").is_empty());
        assert!(features("delete window?.structuredClone;").is_empty());
        assert!(features("delete (window?.structuredClone);").is_empty());
        assert!(features("delete Object?.groupBy;").is_empty());
        assert!(features("delete window?.navigator.userActivation;").is_empty());
    }

    #[test]
    fn an_optional_member_of_a_window_alias_is_a_global() {
        assert_eq!(features("window?.structuredClone(1);"), ["api.structuredClone"]);
    }

    #[test]
    fn a_constructor_through_a_window_alias_is_an_api_use() {
        let uses = with_semantic("new window.ResizeObserver(cb);", "a.js", |semantic, _| {
            detect(semantic)
                .into_iter()
                .map(|usage| (usage.feature.as_str(), usage.kind))
                .collect::<Vec<_>>()
        })
        .unwrap();
        assert_eq!(uses, [("api.ResizeObserver.ResizeObserver", Kind::Api)]);
    }

    #[test]
    fn destructuring_from_a_global_uses_the_member() {
        assert_eq!(
            detected("const { userActivation } = navigator;"),
            [(
                "api.Navigator.userActivation",
                vec!["navigator.userActivation".to_string()]
            )]
        );
        assert_eq!(
            detected("const { groupBy } = Object;"),
            [("javascript.builtins.Object.groupBy", vec!["Object.groupBy".to_string()])]
        );
        assert_eq!(
            detected("const { structuredClone } = window;"),
            [("api.structuredClone", vec!["structuredClone".to_string()])]
        );
        assert_eq!(
            features("const { groupBy: g, 'fromAsync': h } = Object;"),
            ["javascript.builtins.Object.groupBy"]
        );
        assert_eq!(
            features("let s; ({ structuredClone: s } = window);"),
            ["api.structuredClone"]
        );
        assert_eq!(
            features("({ groupBy } = Object);"),
            ["javascript.builtins.Object.groupBy"]
        );
        // Without a known member, the destructuring reads only the global itself, as `Array.a` does.
        assert_eq!(features("let a; ({ a } = Array);"), ["javascript.builtins.Array"]);
        assert_eq!(
            features("function f({ userActivation } = navigator) {}"),
            ["api.Navigator.userActivation"]
        );
    }

    #[test]
    fn a_default_value_of_a_destructuring_target_is_a_source() {
        assert_eq!(
            detected("[{ userActivation } = navigator] = arr;"),
            [(
                "api.Navigator.userActivation",
                vec!["navigator.userActivation".to_string()]
            )]
        );
        assert_eq!(
            features("({ a: { groupBy } = Object } = o);"),
            ["javascript.builtins.Object.groupBy"]
        );
    }

    #[test]
    fn destructuring_with_a_literal_computed_key_uses_the_member() {
        assert_eq!(
            detected("const { ['groupBy']: g, [k]: h } = Object;"),
            [("javascript.builtins.Object.groupBy", vec!["Object.groupBy".to_string()])]
        );
        assert_eq!(
            detected("const { ['structuredClone']: s } = window;"),
            [("api.structuredClone", vec!["structuredClone".to_string()])]
        );
        assert_eq!(
            features("let g; ({ ['groupBy']: g } = Object);"),
            ["javascript.builtins.Object.groupBy"]
        );
    }

    #[test]
    fn destructuring_with_a_variable_computed_key_is_skipped() {
        // Without a known member, the destructuring reads only the global itself.
        assert_eq!(features("const { [k]: h } = Object;"), ["javascript.builtins.Object"]);
        assert!(features("let s; ({ [k]: s } = window);").is_empty());
    }

    #[test]
    fn the_node_of_a_destructured_member_is_the_property() {
        let source = "const { userActivation } = navigator;";
        let nodes = with_semantic(source, "a.js", |semantic, _| {
            detect(semantic)
                .into_iter()
                .map(|usage| {
                    let kind = semantic.nodes().kind(usage.node);
                    (
                        matches!(kind, AstKind::BindingProperty(_)),
                        kind.span() == usage.span,
                        usage.span.source_text(source).to_string(),
                    )
                })
                .collect::<Vec<_>>()
        })
        .unwrap();
        assert_eq!(nodes, [(true, true, "userActivation".to_string())]);
    }

    #[test]
    fn members_of_singletons_resolve_through_parent_interfaces() {
        assert_eq!(
            detected("document.when('click');"),
            [("api.EventTarget.when", vec!["document.when".to_string()])]
        );
        assert_eq!(
            features("document.addEventListener('click', f);"),
            ["api.EventTarget.addEventListener"]
        );
        assert_eq!(features("document.contains(a);"), ["api.Node.contains"]);
        // The own entry of the interface wins over the entry of a parent.
        assert_eq!(features("document.querySelector('a');"), ["api.Document.querySelector"]);
        assert_eq!(features("const { when } = document;"), ["api.EventTarget.when"]);
    }
}

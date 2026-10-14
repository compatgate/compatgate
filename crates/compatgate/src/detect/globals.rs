//! Uses of global objects, constructors and functions: `structuredClone()`, `new Intl.Segmenter()`,
//! `window.structuredClone`, `navigator.userActivation`, `const { groupBy } = Object`. Only references
//! that resolve to no declared binding count, so a local `structuredClone` is ignored. The root of a
//! chain is a use of its own: `navigation.currentEntry` reads `navigation`, which throws where it is missing.

use oxc_ast::AstKind;
use oxc_ast::ast::{AssignmentTarget, AssignmentTargetProperty, BindingPattern};
use oxc_semantic::{AstNodes, NodeId, Semantic};
use oxc_span::Span;

use super::path::{Member, WINDOW_ALIASES, key_name, member_at, member_over};
use super::slot::{Pattern, Slot, destructuring, outermost, slot};
use super::{Key, Origin, Use};
use crate::check::Kind;
use crate::data::{FeatureId, global_feature, member_feature};
use crate::targets::Targets;

pub fn detect<'a>(semantic: &Semantic<'a>, targets: &Targets) -> Vec<Use<'a>> {
    let scoping = semantic.scoping();
    let nodes = semantic.nodes();
    let mut uses = Uses {
        uses: Vec::new(),
        targets,
    };
    for references in scoping.root_unresolved_references().values() {
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
            let name = identifier.name.as_str();
            let is_alias = WINDOW_ALIASES.contains(&name);
            // The root of a chain is a use of its own: `navigation` in `navigation.currentEntry` throws where
            // it is missing. Through an alias the root is a member, `window.navigation`.
            let root =
                || global_feature(name, false).map(|feature| (feature, Origin::Global, identifier.span, node_id));
            // The position of the reference decides the rest, so it is found once.
            let outer = outermost(nodes, node_id);
            let position = slot(nodes, outer);
            if let Some(first) = member_at(nodes, outer, position) {
                // `window.structuredClone = polyfill` and `Object.groupBy = polyfill` define a member.
                if is_written_or_deleted(nodes, first.id) {
                    continue;
                }
                if is_alias {
                    let root = global_feature(first.property, false)
                        .map(|feature| (feature, Origin::Member, first.span, first.id));
                    // `window.navigator.userActivation` resolves like `navigator.userActivation`.
                    if let Some(second) = member_over(nodes, first.id) {
                        if is_written_or_deleted(nodes, second.id) {
                            continue;
                        }
                        if let Some(feature) = member_feature(first.property, second.property) {
                            uses.chain(root, &[first.property], &[(feature, second)], true);
                            continue;
                        }
                    } else {
                        // `const { share } = window.navigator` resolves like `= navigator`.
                        let outer = outermost(nodes, first.id);
                        let position = slot(nodes, outer);
                        let members = resolve_members(destructured(nodes, outer, position), |property| {
                            member_feature(first.property, property)
                        });
                        if !members.is_empty() {
                            uses.chain(root, &[first.property], &members, false);
                            continue;
                        }
                    }
                    if let Some(feature) = global_feature(first.property, is_new_callee(nodes, first.id)) {
                        uses.add(feature, Origin::Member, first.span, first.id, || vec![first.property]);
                    }
                    continue;
                }
                if let Some(feature) = member_feature(name, first.property) {
                    uses.chain(root(), &[name], &[(feature, first)], true);
                    continue;
                }
            } else {
                // `const { groupBy } = Object` reads `Object.groupBy`, as the member access does.
                let members = resolve_members(destructured(nodes, outer, position), |property| {
                    if is_alias {
                        global_feature(property, false)
                    } else {
                        member_feature(name, property)
                    }
                });
                if !members.is_empty() {
                    // `const { structuredClone } = window` reads the global `structuredClone`.
                    match is_alias {
                        true => uses.chain(None, &[], &members, false),
                        false => uses.chain(root(), &[name], &members, false),
                    }
                    continue;
                }
            }
            // A bare `window` or `self` is not a use of a feature.
            if is_alias {
                continue;
            }
            if position == Slot::Delete {
                continue;
            }
            if let Some(feature) = global_feature(name, position == Slot::NewCallee) {
                uses.add(feature, Origin::Global, identifier.span, node_id, || vec![name]);
            }
        }
    }
    uses.uses
}

/// The uses of a file. A resolved feature that the targets support is no use, but it still stops
/// the resolution: `Object.groupBy` is not a use of `Object` when the targets support `groupBy`.
struct Uses<'r, 'a> {
    uses: Vec<Use<'a>>,
    targets: &'r Targets,
}

impl<'a> Uses<'_, 'a> {
    /// `path` gives the key of the use: the path without the aliases of the global object. Most features
    /// are supported, so the path is built only for a use that stays.
    fn add(
        &mut self,
        feature: FeatureId,
        origin: Origin,
        span: Span,
        node: NodeId,
        path: impl FnOnce() -> Vec<&'a str>,
    ) {
        if !self.targets.is_supported(feature) {
            self.uses.push(Use {
                key: Some(Key::Path(path())),
                ..Use::new(feature, kind_of(feature), origin, span, node)
            });
        }
    }

    /// The root of a chain and the members that the chain reads from it. A member is no use when every
    /// target version without full support of it lacks the root: the root reports the gap, and a check
    /// of the root covers the member.
    ///
    /// A member read (`read`) that implies the root takes the place of the root: `scheduler.yield()` is one
    /// finding of `Scheduler.yield` while it is a finding. A destructuring reads the root once for all
    /// its members, so its root stays.
    ///
    /// `path` is the path of the root, and each member adds its name to it.
    fn chain(
        &mut self,
        root: Option<(FeatureId, Origin, Span, NodeId)>,
        path: &[&'a str],
        members: &[(FeatureId, Member<'a>)],
        read: bool,
    ) {
        let start = self.uses.len();
        if let Some((feature, origin, span, node)) = root {
            self.add(feature, origin, span, node, || path.to_vec());
        }
        let added_root = self.uses.len() > start;
        for &(feature, ref member) in members {
            if root.is_some_and(|(root, ..)| self.targets.implies(root, feature)) {
                continue;
            }
            self.add(feature, Origin::Member, member.span, member.id, || {
                [path, &[member.property]].concat()
            });
            if let Some((root, ..)) = root
                && read
                && added_root
                && self.targets.implies(feature, root)
            {
                self.uses[start].member = Some(member.id);
            }
        }
    }
}

/// The destructured members whose feature `resolve` finds.
fn resolve_members<'a>(
    members: Vec<Member<'a>>,
    mut resolve: impl FnMut(&str) -> Option<FeatureId>,
) -> Vec<(FeatureId, Member<'a>)> {
    members
        .into_iter()
        .filter_map(|member| Some((resolve(member.property)?, member)))
        .collect()
}

/// The properties that a destructuring takes from the expression `X` at `outer` in the position
/// `position`: `const { a, b: c } = X`, `({ a } = X)`, `function f({ a } = X) {}`, `[{ a } = X] = list`.
/// A computed key names a member only when it is a literal, as in `X['a']`.
fn destructured<'a>(nodes: &AstNodes<'a>, outer: NodeId, position: Slot) -> Vec<Member<'a>> {
    if position != Slot::DestructuringSource {
        return Vec::new();
    }
    match destructuring(nodes, outer) {
        Some(Pattern::Binding(pattern)) => pattern_members(pattern),
        Some(Pattern::Target(target)) => target_members(target),
        None => Vec::new(),
    }
}

/// The properties of a declaration pattern `{ a, b: c }`.
fn pattern_members<'a>(pattern: &BindingPattern<'a>) -> Vec<Member<'a>> {
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
                property: key_name(&property.key)?,
            })
        })
        .collect()
}

/// The properties of an assignment pattern `({ a, b: c } = X)`.
fn target_members<'a>(target: &AssignmentTarget<'a>) -> Vec<Member<'a>> {
    let AssignmentTarget::ObjectAssignmentTarget(target) = target else {
        return Vec::new();
    };
    target
        .properties
        .iter()
        .filter_map(|property| {
            let (id, span, property) = match property {
                AssignmentTargetProperty::AssignmentTargetPropertyIdentifier(property) => {
                    (property.node_id(), property.span, property.binding.name.as_str())
                }
                AssignmentTargetProperty::AssignmentTargetPropertyProperty(property) => {
                    (property.node_id(), property.span, key_name(&property.name)?)
                }
            };
            Some(Member { id, span, property })
        })
        .collect()
}

/// The member is a target that the code writes or deletes, not a value that it reads:
/// `X.m = v`, `[X.m] = a`, `({ a: X.m = d } = o)`, `for (X.m of list)`, `delete X.m`.
fn is_written_or_deleted(nodes: &AstNodes<'_>, member: NodeId) -> bool {
    matches!(slot(nodes, outermost(nodes, member)), Slot::AssignTarget | Slot::Delete)
}

fn is_new_callee(nodes: &AstNodes<'_>, member: NodeId) -> bool {
    slot(nodes, outermost(nodes, member)) == Slot::NewCallee
}

/// The feature of a path that a check names: `structuredClone`, `navigator.share`, `Intl.Segmenter`.
/// The guards compare its absence mask with the use that the check protects.
pub(crate) fn path_feature(path: &[&str]) -> Option<FeatureId> {
    match path {
        [name] => global_feature(name, false),
        [object, property] => member_feature(object, property),
        _ => None,
    }
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
    use oxc_span::GetSpan;

    use super::*;
    use crate::check::with_semantic;

    fn detected(source: &str) -> Vec<(&'static str, Vec<String>)> {
        detected_in(source, "a.js")
    }

    /// Targets that lack every feature but the objects at the roots of the chains in these tests, as
    /// common targets do. A missing root would hide the members that it lacks wherever they are missing.
    fn targets() -> Targets {
        let roots = ["navigator", "Object", "Intl", "document"].map(|name| path_feature(&[name]).unwrap());
        Targets::missing_except(&roots)
    }

    fn detected_in(source: &str, filename: &str) -> Vec<(&'static str, Vec<String>)> {
        with_semantic(source, filename, |semantic, _| {
            detect(semantic, &targets())
                .into_iter()
                .map(|usage| {
                    let key = super::super::guards::key_text(&usage);
                    (usage.feature.as_str(), key.into_iter().collect())
                })
                .collect()
        })
        .unwrap()
    }

    fn features(source: &str) -> Vec<&'static str> {
        detected(source).into_iter().map(|(feature, _)| feature).collect()
    }

    #[test]
    fn a_global_that_the_targets_support_is_no_use() {
        let source = "Object.groupBy(a, f); structuredClone(x); const { share } = window.navigator;";
        let found = |query: &str| {
            with_semantic(source, "a.js", |semantic, _| {
                detect(semantic, &Targets::resolve(query).unwrap())
                    .into_iter()
                    .map(|usage| (usage.feature.as_str(), usage.origin))
                    .collect::<Vec<_>>()
            })
            .unwrap()
        };
        assert!(found("Chrome >= 128").is_empty());
        let mut old = found("Chrome >= 80");
        old.sort_by_key(|&(feature, _)| feature);
        assert_eq!(
            old,
            [
                ("api.Navigator.share", Origin::Member),
                ("api.structuredClone", Origin::Global),
                ("javascript.builtins.Object.groupBy", Origin::Member),
            ]
        );
    }

    #[test]
    fn the_root_of_a_chain_is_a_use_of_its_own() {
        let found = |source: &str, targets: &Targets| {
            with_semantic(source, "a.js", |semantic, _| {
                let mut uses: Vec<_> = detect(semantic, targets)
                    .into_iter()
                    .map(|usage| (usage.feature.as_str(), usage.origin))
                    .collect();
                uses.sort_by_key(|&(feature, _)| feature);
                uses
            })
            .unwrap()
        };
        let common = Targets::resolve("Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115").unwrap();
        // Every browser without `Navigation.currentEntry` lacks `navigation`, so the root reports the gap.
        assert_eq!(
            found("navigation.currentEntry;", &common),
            [("api.Window.navigation", Origin::Global)]
        );
        assert_eq!(
            found("window.navigation.currentEntry;", &common),
            [("api.Window.navigation", Origin::Member)]
        );
        assert_eq!(
            found("const { currentEntry } = navigation;", &common),
            [("api.Window.navigation", Origin::Global)]
        );
        // Chrome 97 has `scheduler` but not `Scheduler.yield`, so both are uses.
        assert_eq!(
            found("scheduler.yield();", &common),
            [
                ("api.Scheduler.yield", Origin::Member),
                ("api.scheduler", Origin::Global)
            ]
        );
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
            detect(semantic, &Targets::missing_everything())
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
        assert_eq!(features("const { [k]: h } = Array;"), ["javascript.builtins.Array"]);
        assert!(features("let s; ({ [k]: s } = window);").is_empty());
    }

    #[test]
    fn the_node_of_a_destructured_member_is_the_property() {
        let source = "const { userActivation } = navigator;";
        let nodes = with_semantic(source, "a.js", |semantic, _| {
            detect(semantic, &targets())
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

    #[test]
    fn members_of_the_global_object_resolve_through_parent_interfaces() {
        assert_eq!(
            detected("window.when('click');"),
            [("api.EventTarget.when", vec!["when".to_string()])]
        );
        assert_eq!(
            detected("when('click');"),
            [("api.EventTarget.when", vec!["when".to_string()])]
        );
        let mut inherited =
            features("self.addEventListener('a', f); globalThis.dispatchEvent(e); removeEventListener('a', f);");
        inherited.sort_unstable();
        assert_eq!(
            inherited,
            [
                "api.EventTarget.addEventListener",
                "api.EventTarget.dispatchEvent",
                "api.EventTarget.removeEventListener"
            ]
        );
        assert_eq!(features("const { when } = window;"), ["api.EventTarget.when"]);
        // The own entry of `Window` and the builtins win over the entries of its parents.
        assert_eq!(features("window.name; name;"), ["api.Window.name"; 2]);
        assert_eq!(features("window.Array;"), ["javascript.builtins.Array"]);
    }

    #[test]
    fn a_computed_key_with_a_dot_names_no_sub_feature() {
        // BCD ids such as `api.Navigator.share.data_files_parameter` are sub-features, not members. Before the
        // generated tables each of these lines resolved to such an id.
        assert!(features("f(window['screenLeft.relative-multi-screen']);").is_empty());
        assert!(features("f(navigator['share.data_files_parameter']);").is_empty());
        assert!(features("f(Intl['Segmenter.segment']);").is_empty());
    }

    #[test]
    fn an_alias_of_the_global_object_is_an_object_with_members() {
        // `window.self.when` asks the member table for `self.when`, so the rows of `self` and `window` stay.
        // The root `self` is a use of its own here: the test targets lack it.
        assert_eq!(
            detected("window.self.when('click');"),
            [
                ("api.Window.self", vec!["self".to_string()]),
                ("api.EventTarget.when", vec!["self.when".to_string()])
            ]
        );
        assert_eq!(
            features("const { when } = self.window;"),
            ["api.Window.window", "api.EventTarget.when"]
        );
    }

    #[test]
    fn unknown_or_local_members_of_the_global_object_are_not_uses() {
        assert!(features("window.noSuchThing(); noSuchThing();").is_empty());
        assert!(features("const when = f; when('click');").is_empty());
        assert!(features("const window = w; window.when('click');").is_empty());
        assert!(features("window.when = f; when = f;").is_empty());
    }

    #[test]
    fn destructuring_from_a_member_of_a_window_alias_uses_the_member() {
        assert_eq!(
            detected("const { share } = window.navigator;"),
            [("api.Navigator.share", vec!["navigator.share".to_string()])]
        );
        assert_eq!(
            detected("const { userActivation } = globalThis.navigator;"),
            [(
                "api.Navigator.userActivation",
                vec!["navigator.userActivation".to_string()]
            )]
        );
        assert_eq!(
            detected("const { groupBy } = window.Object;"),
            [("javascript.builtins.Object.groupBy", vec!["Object.groupBy".to_string()])]
        );
        assert_eq!(
            features("let s; ({ share: s } = self.navigator);"),
            ["api.Navigator.share"]
        );
        assert_eq!(
            features("const { share } = window?.navigator;"),
            ["api.Navigator.share"]
        );
        assert_eq!(
            features("const { share } = (window.navigator);"),
            ["api.Navigator.share"]
        );
    }

    #[test]
    fn destructuring_from_other_members_is_not_a_member_use() {
        assert!(features("const { share } = foo.navigator;").is_empty());
        assert!(features("const window = w; const { share } = window.navigator;").is_empty());
        assert!(features("const { share } = window.noSuchThing;").is_empty());
        // The source is `navigator.share`, not `navigator`: no member of it is read.
        assert_eq!(
            features("const { a } = window.navigator.share;"),
            ["api.Navigator.share"]
        );
    }

    #[test]
    fn the_parents_of_window_add_only_the_event_target_members() {
        // Every bare name that resolves to a member of a parent of `Window`, not to an own entry.
        let mut inherited: Vec<&str> = crate::data::feature_ids()
            .filter_map(|id| {
                let member = id.strip_prefix("api.")?.split_once('.')?.1;
                let feature = global_feature(member, false)?.as_str();
                (feature == id && !member.contains('.') && !feature.starts_with("api.Window.")).then_some(feature)
            })
            .collect();
        inherited.sort_unstable();
        assert_eq!(
            inherited,
            [
                "api.EventTarget.addEventListener",
                "api.EventTarget.dispatchEvent",
                "api.EventTarget.removeEventListener",
                "api.EventTarget.when"
            ]
        );
    }
}

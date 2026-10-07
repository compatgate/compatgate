//! Uses of global objects, constructors and functions: `structuredClone()`, `new Intl.Segmenter()`.
//! Only references that resolve to no declared binding count, so a local `structuredClone` is ignored.

use oxc_ast::AstKind;
use oxc_semantic::Semantic;
use oxc_span::GetSpan;

use super::Use;
use crate::check::Kind;
use crate::data::FeatureId;

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
            let node_id = reference.node_id();
            let AstKind::IdentifierReference(identifier) = nodes.kind(node_id) else {
                continue;
            };
            let parent = nodes.parent_kind(node_id);
            if let AstKind::StaticMemberExpression(member) = parent
                && member.object.span() == identifier.span
                && let Some(feature) = member_feature(name, member.property.name.as_str())
            {
                uses.push(Use {
                    feature,
                    kind: kind_of(feature),
                    span: member.span,
                });
                continue;
            }
            let is_new =
                matches!(parent, AstKind::NewExpression(expression) if expression.callee.span() == identifier.span);
            if let Some(feature) = global_feature(name, is_new) {
                uses.push(Use {
                    feature,
                    kind: kind_of(feature),
                    span: identifier.span,
                });
            }
        }
    }
    uses
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

fn kind_of(feature: FeatureId) -> Kind {
    if feature.as_str().starts_with("api.") {
        Kind::Api
    } else {
        Kind::Builtin
    }
}

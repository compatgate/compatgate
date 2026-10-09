//! Uses of prototype methods by name: `.toSorted()`, `.union()`. The detector takes the reads of
//! members with a method name, `arr.toSorted` and `arr['toSorted']`, and the guards follow their values.
//!
//! The receiver of a literal has a known type: `[]`, `new Set()`, `new Map()`, a string, a template, a
//! regular expression, a number, a BigInt and a boolean. Its read is a use wherever it is, as a read of
//! a global member is. The finding names the method of that type and is exact, and a type without the
//! method gives none.
//!
//! For another receiver the type is unknown, so the findings are heuristic. Such a read is a use only
//! when the code calls its value: `arr.toSorted()`, `arr.toSorted?.()`, `(0, arr.toSorted)()`,
//! `arr.toSorted.call(…)`, `arr.toSorted.apply(…)`, or a call of an alias `const f = arr.toSorted; f()`.
//! Many objects have data properties with method names, `compilation.chunks` of webpack and
//! `options.windows` of picomatch, and a read that is never called is most likely one of them.
//! Three more rules keep the noise down:
//! - a name that a supported member of any type also has (`.map()` of arrays) is skipped;
//! - a name that the file declares as a member (`class Q { union() {} }`) is skipped;
//! - a call on an imported module (`_.union()` of lodash, `R.take()` of Ramda) is skipped.
//!
//! A destructured method, `const { toSorted } = arr`, is no use: without a type a name in a pattern
//! tells even less than a call.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use oxc_ast::AstKind;
use oxc_ast::ast::{Expression, IdentifierReference};
use oxc_semantic::{NodeId, Semantic, SymbolFlags};
use oxc_span::Span;

use super::alias::Aliases;
use super::path::{is_global, key_name, member_at, property, root};
use super::slot::{Slot, slot};
use super::{Key, Origin, Use};
use crate::check::{Confidence, Kind};
use crate::data::{FeatureId, instance_member_names, instance_members};
use crate::support::{SupportTable, TargetSupport};
use crate::targets::Targets;

pub fn detect<'a>(semantic: &Semantic<'a>, targets: &Targets) -> Vec<Use<'a>> {
    let mut declared = None;
    let mut aliases = None;
    let mut uses = Vec::new();
    for node in semantic.nodes().iter() {
        let Some((object, name, span)) = member_read(node.kind()) else {
            continue;
        };
        if let Some(of) = literal_type(semantic, object) {
            // The type is known, so the names that the file declares and the other types do not matter.
            if let Some(feature) = typed_method(of, name).filter(|&feature| !targets.is_supported(feature)) {
                uses.push(Use {
                    key: Some(Key::Method(name)),
                    ..Use::new(feature, Kind::Builtin, Origin::Method, span, node.id())
                });
            }
            continue;
        }
        // Most names have a supported member, so the decision goes first. It is a lookup in the targets.
        let Some(decision) = targets.method(name) else {
            continue;
        };
        // Few files read a candidate at all, so the declared names wait for the first candidate.
        if declared.get_or_insert_with(|| declared_names(semantic)).contains(name) {
            continue;
        }
        if receiver_is_module(semantic, object) {
            continue;
        }
        // Its own `Aliases`, not the one of the guards: the same code, built lazily for few candidates,
        // and the detectors run before the guards exist.
        if !is_called(
            semantic,
            aliases.get_or_insert_with(|| Aliases::new(semantic)),
            node.id(),
        ) {
            continue;
        }
        uses.push(Use {
            alternatives: decision.alternatives,
            confidence: Confidence::Heuristic,
            key: Some(Key::Method(name)),
            ..Use::new(decision.feature, Kind::Builtin, Origin::Method, span, node.id())
        });
    }
    uses
}

/// The object, the name and the span of the name of a member read: `x.name` and `x['name']`.
fn member_read<'a>(kind: AstKind<'a>) -> Option<(&'a Expression<'a>, &'a str, Span)> {
    match kind {
        AstKind::StaticMemberExpression(member) => {
            Some((&member.object, member.property.name.as_str(), member.property.span))
        }
        AstKind::ComputedMemberExpression(member) => match member.expression.get_inner_expression() {
            Expression::StringLiteral(key) => Some((&member.object, key.value.as_str(), key.span)),
            _ => None,
        },
        _ => None,
    }
}

/// Whether the code calls the value of the member read at `node`: `x.m()`, `x.m?.()`, `(0, x.m)()`,
/// `x.m.call(…)`, `x.m.apply(…)`, or a read of an alias that holds it, `const f = x.m; f()`.
/// A walk climbs only through wrappers, the last expression of a sequence and one `.call` or `.apply`,
/// and an alias holds the value of one expression, so different reads walk different nodes, and the
/// walks of a file stay linear.
fn is_called<'a>(semantic: &Semantic<'a>, aliases: &mut Aliases<'_, 'a>, node: NodeId) -> bool {
    let nodes = semantic.nodes();
    let mut pending = vec![node];
    let mut followed = HashSet::new();
    while let Some(mut id) = pending.pop() {
        let mut through_call = false;
        loop {
            count!(methods);
            let position = slot(nodes, id);
            match position {
                Slot::Wrapper | Slot::SeqLast => id = nodes.parent_id(id),
                Slot::Callee { .. } => return true,
                // `x.m.call(…)` and `x.m.apply(…)` call `x.m`.
                Slot::Object { .. } if !through_call => match member_at(nodes, id, position) {
                    Some(member) if matches!(member.property, "call" | "apply") => {
                        through_call = true;
                        id = member.id;
                    }
                    _ => break,
                },
                Slot::AssignValue | Slot::Other => {
                    if let Some(alias) = aliases.stored_into(id)
                        && followed.insert(alias)
                    {
                        pending.extend(aliases.reads(alias));
                    }
                    break;
                }
                _ => break,
            }
        }
    }
    false
}

/// The builtin type of a literal receiver: `[]`, `new Set()`, `new Map()`, a string, a template without
/// a tag, a regular expression, a number, a BigInt and a boolean. `new Set()` counts only with the
/// global `Set`.
fn literal_type(semantic: &Semantic<'_>, object: &Expression<'_>) -> Option<&'static str> {
    match object.get_inner_expression() {
        Expression::ArrayExpression(_) => Some("Array"),
        Expression::StringLiteral(_) | Expression::TemplateLiteral(_) => Some("String"),
        Expression::RegExpLiteral(_) => Some("RegExp"),
        Expression::NumericLiteral(_) => Some("Number"),
        Expression::BigIntLiteral(_) => Some("BigInt"),
        Expression::BooleanLiteral(_) => Some("Boolean"),
        Expression::NewExpression(new) => match new.callee.get_inner_expression() {
            Expression::Identifier(callee) if is_global(semantic, callee) => match callee.name.as_str() {
                "Set" => Some("Set"),
                "Map" => Some("Map"),
                _ => None,
            },
            _ => None,
        },
        _ => None,
    }
}

/// The method `name` of the builtin type `of`: `javascript.builtins.Array.toSorted` for `Array` and
/// `toSorted`. Only the members that a finding may name count, as for a heuristic finding.
fn typed_method(of: &str, name: &str) -> Option<FeatureId> {
    instance_members(name).find_map(|(feature, reportable)| {
        let rest = feature
            .as_str()
            .strip_prefix("javascript.builtins.")?
            .strip_prefix(of)?;
        (reportable && rest.strip_prefix('.') == Some(name)).then_some(feature)
    })
}

/// The finding for a call of a method name: the feature it names and the other members with the name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Decision {
    pub feature: FeatureId,
    pub alternatives: &'static [FeatureId],
}

/// The decisions for every method name under one set of targets. Only names with a finding have an
/// entry: a name that a supported member of any type also has (`.map()` of arrays) has none.
#[derive(Clone, PartialEq, Eq)]
pub struct MethodTable {
    names: Box<[(&'static str, Decision)]>,
}

impl MethodTable {
    pub fn new(table: &SupportTable) -> Self {
        let names = instance_member_names()
            .filter_map(|name| {
                let feature = decide(name, table)?;
                Some((
                    name,
                    Decision {
                        feature,
                        alternatives: alternatives(name, feature),
                    },
                ))
            })
            .collect();
        Self { names }
    }

    pub fn get(&self, name: &str) -> Option<Decision> {
        let index = self.names.binary_search_by(|&(known, _)| known.cmp(name)).ok()?;
        Some(self.names[index].1)
    }
}

/// For every reportable member of every name, the other reportable members of the name, in the order
/// of their ids. They do not depend on the targets, so a decision points into this table.
static ALTERNATIVES: LazyLock<Alternatives> = LazyLock::new(|| {
    let mut list = Vec::new();
    let mut ranges = HashMap::new();
    for name in instance_member_names() {
        let reportable: Vec<FeatureId> = instance_members(name)
            .filter_map(|(feature, reportable)| reportable.then_some(feature))
            .collect();
        for &chosen in &reportable {
            let start = list.len() as u32;
            list.extend(reportable.iter().copied().filter(|&other| other != chosen));
            ranges.insert((name, chosen), (start, list.len() as u32));
        }
    }
    Alternatives {
        list: list.into(),
        ranges,
    }
});

struct Alternatives {
    list: Box<[FeatureId]>,
    /// By name and chosen member: the range of the others in `list`.
    ranges: HashMap<(&'static str, FeatureId), (u32, u32)>,
}

/// The reportable members of `name` other than `chosen`.
fn alternatives(name: &'static str, chosen: FeatureId) -> &'static [FeatureId] {
    let alternatives = &*ALTERNATIVES;
    match alternatives.ranges.get(&(name, chosen)) {
        Some(&(start, end)) => &alternatives.list[start as usize..end as usize],
        None => &[],
    }
}

impl std::fmt::Debug for MethodTable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "MethodTable {{ {} names with a finding }}", self.names.len())
    }
}

/// Member names that the file declares: methods, fields and accessors of classes, keys of object literals,
/// and targets of `obj.name = …` and `obj['name'] = …`. A call of such a name most likely calls the code
/// of the file, so the detector skips it. Ambient class members (`abstract take()`, `declare take`) count
/// on purpose: they declare a member of the file's own class and do not augment builtins. Members of
/// interfaces do not count.
fn declared_names<'a>(semantic: &Semantic<'a>) -> HashSet<&'a str> {
    let mut names = HashSet::new();
    for node in semantic.nodes().iter() {
        let name = match node.kind() {
            AstKind::MethodDefinition(method) => key_name(&method.key),
            AstKind::PropertyDefinition(property) => key_name(&property.key),
            AstKind::AccessorProperty(property) => key_name(&property.key),
            AstKind::ObjectProperty(property) => key_name(&property.key),
            AstKind::AssignmentExpression(assignment) => assignment.left.as_member_expression().and_then(property),
            _ => None,
        };
        if let Some(name) = name {
            names.insert(name);
        }
    }
    names
}

fn decide(name: &str, table: &SupportTable) -> Option<FeatureId> {
    let mut candidates = Vec::new();
    // `instance_members` yields the members in the order of their ids: the data is sorted by name
    // and feature index, and the features are sorted by id. Tests in `data` check both orders.
    for (feature, reportable) in instance_members(name) {
        let support = table.get(feature);
        if support.is_supported() {
            return None;
        }
        if reportable {
            candidates.push((feature, support));
        }
    }
    choose(&candidates)
}

/// The call may be any of the candidates, so the finding names the one with the worst support:
/// missing in some target before partial. Ties go to the first candidate. The candidates come in the
/// order of their ids.
fn choose(candidates: &[(FeatureId, TargetSupport)]) -> Option<FeatureId> {
    let severity = |support: &TargetSupport| {
        if !support.missing.is_empty() {
            2
        } else if !support.partial.is_empty() {
            1
        } else {
            0
        }
    };
    let mut worst = 0;
    for (index, (_, support)) in candidates.iter().enumerate() {
        if severity(support) > severity(&candidates[worst].1) {
            worst = index;
        }
    }
    Some(candidates.get(worst)?.0)
}

/// `_.union()` with `import _ from 'lodash'` or `const _ = require('lodash')` calls a module function.
fn receiver_is_module(semantic: &Semantic<'_>, object: &Expression<'_>) -> bool {
    let identifier = match root(object) {
        Expression::Identifier(identifier) => identifier,
        other => return is_module_expression(semantic, other),
    };
    let scoping = semantic.scoping();
    let Some(symbol) = scoping.get_reference(identifier.reference_id()).symbol_id() else {
        return false;
    };
    if scoping.symbol_flags(symbol).contains(SymbolFlags::Import) {
        return true;
    }
    // oxc records the declarator as the declaration of a symbol, destructuring included.
    matches!(
        semantic.nodes().kind(scoping.symbol_declaration(symbol)),
        AstKind::VariableDeclarator(declarator)
            if declarator.init.as_ref().is_some_and(|init| is_module_expression(semantic, init))
    )
}

/// A value that comes from a module: `require('x')`, `__webpack_require__(1)`, its minified form `n(1)`,
/// `import('x')`, and those behind `.default`, `await`, `(0, …)` or an interop wrapper such as
/// `__importDefault(require('x'))`. A single-argument call counts only when its argument is itself
/// a module expression.
fn is_module_expression(semantic: &Semantic<'_>, expression: &Expression<'_>) -> bool {
    match expression.get_inner_expression() {
        Expression::ImportExpression(_) => true,
        Expression::AwaitExpression(await_expression) => is_module_expression(semantic, &await_expression.argument),
        Expression::StaticMemberExpression(member) => is_module_expression(semantic, &member.object),
        Expression::ComputedMemberExpression(member) => is_module_expression(semantic, &member.object),
        Expression::SequenceExpression(sequence) => sequence
            .expressions
            .last()
            .is_some_and(|last| is_module_expression(semantic, last)),
        Expression::CallExpression(call) => {
            let Expression::Identifier(callee) = call.callee.get_inner_expression() else {
                return false;
            };
            match callee.name.as_str() {
                "require" => return is_module_loader(semantic, callee),
                "__webpack_require__" => return true,
                _ => {}
            }
            let [argument] = call.arguments.as_slice() else {
                return false;
            };
            let Some(argument) = argument.as_expression() else {
                return false;
            };
            is_minified_require(semantic, callee, argument) || is_module_expression(semantic, argument)
        }
        _ => false,
    }
}

/// `n(96540)` inside `(e, t, n) => {…}`: webpack passes `(module, exports, __webpack_require__)` to a
/// module function, and SWC and terser rename the third parameter to a short name. A minifier cannot
/// drop the leading parameters, so the loader stays the third. A production build numbers the modules,
/// a development build names them: `n("./src/a.js")`. The cost: ordinary code that calls the third
/// parameter of a function with a lone integer or string loses its heuristic finding. A finding on a
/// literal receiver is exact and does not depend on this rule.
fn is_minified_require(semantic: &Semantic<'_>, callee: &IdentifierReference<'_>, argument: &Expression<'_>) -> bool {
    match argument.get_inner_expression() {
        Expression::NumericLiteral(id) if id.value.fract() == 0.0 => {}
        Expression::StringLiteral(_) => {}
        _ => return false,
    }
    let scoping = semantic.scoping();
    let nodes = semantic.nodes();
    let Some(symbol) = scoping.get_reference(callee.reference_id()).symbol_id() else {
        return false;
    };
    let declaration = scoping.symbol_declaration(symbol);
    let (AstKind::FormalParameter(parameter), AstKind::FormalParameters(list)) =
        (nodes.kind(declaration), nodes.parent_kind(declaration))
    else {
        return false;
    };
    list.items.get(2).is_some_and(|third| third.span == parameter.span)
}

/// `require` loads modules when it is the global of CommonJS, its TypeScript declaration
/// (`declare const require: any`), a parameter of a module wrapper (`function (require, module, exports)`
/// of Browserify, `define(['require'], require => …)` of AMD), or a variable that holds a loader:
/// `createRequire(import.meta.url)` of Node.js or `__webpack_require__`.
/// A local function or another variable named `require` is ordinary code.
fn is_module_loader(semantic: &Semantic<'_>, require: &IdentifierReference<'_>) -> bool {
    let scoping = semantic.scoping();
    let Some(symbol) = scoping.get_reference(require.reference_id()).symbol_id() else {
        return true;
    };
    if scoping.symbol_flags(symbol).contains(SymbolFlags::Ambient) {
        return true;
    }
    match semantic.nodes().kind(scoping.symbol_declaration(symbol)) {
        AstKind::FormalParameter(_) => true,
        AstKind::VariableDeclarator(declarator) => declarator.init.as_ref().is_some_and(holds_loader),
        _ => false,
    }
}

/// `createRequire(…)`, `module.createRequire(…)` or `__webpack_require__`.
fn holds_loader(init: &Expression<'_>) -> bool {
    match init.get_inner_expression() {
        Expression::Identifier(identifier) => identifier.name == "__webpack_require__",
        Expression::CallExpression(call) => match call.callee.get_inner_expression() {
            Expression::Identifier(callee) => callee.name == "createRequire",
            Expression::StaticMemberExpression(member) => member.property.name == "createRequire",
            _ => false,
        },
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::Browser;
    use crate::support::BrowserSet;

    fn feature(id: &str) -> FeatureId {
        FeatureId::find(id).unwrap()
    }

    #[test]
    fn the_finding_names_the_candidate_with_the_worst_support() {
        // In BCD 8.1.4 no method that a finding may name has partial support in any browser,
        // so no name has candidates with different support. The support here is built by hand.
        let first = feature("javascript.builtins.Array.toSorted");
        let second = feature("javascript.builtins.TypedArray.toSorted");
        let firefox: BrowserSet = [Browser::Firefox].into_iter().collect();
        let partial = TargetSupport {
            missing: BrowserSet::EMPTY,
            partial: firefox,
        };
        let unsupported = TargetSupport {
            missing: firefox,
            partial: BrowserSet::EMPTY,
        };
        assert_eq!(choose(&[(first, partial), (second, unsupported)]), Some(second));
        assert_eq!(choose(&[(first, unsupported), (second, partial)]), Some(first));
        assert_eq!(choose(&[(first, unsupported), (second, unsupported)]), Some(first));
        assert_eq!(choose(&[(first, partial), (second, partial)]), Some(first));
        assert_eq!(choose(&[]), None);
        assert!(alternatives("toSorted", first).contains(&second));
        assert!(!alternatives("toSorted", first).contains(&first));
    }

    #[test]
    fn the_table_keeps_only_names_with_a_finding() {
        let targets = Targets::resolve("Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115").unwrap();
        let to_sorted = targets.method("toSorted").unwrap();
        assert_eq!(to_sorted.feature.as_str(), "javascript.builtins.Array.toSorted");
        assert!(
            to_sorted
                .alternatives
                .iter()
                .any(|alternative| alternative.as_str() == "javascript.builtins.TypedArray.toSorted"),
            "{to_sorted:?}"
        );
        assert_eq!(targets.method("map"), None);
        assert_eq!(targets.method("noSuchMember"), None);
        assert_eq!(Targets::resolve("Chrome >= 120").unwrap().method("toSorted"), None);
    }
}

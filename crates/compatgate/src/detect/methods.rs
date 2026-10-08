//! Calls of prototype methods by name: `.toSorted()`, `.union()`. Without types the receiver is
//! unknown, so the findings are heuristic. Three rules keep the noise down:
//! - a name that a supported member of any type also has (`.map()` of arrays) is skipped;
//! - a name that the file declares as a member (`class Q { union() {} }`) is skipped;
//! - a call on an imported module (`_.union()` of lodash, `R.take()` of Ramda) is skipped.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use oxc_ast::AstKind;
use oxc_ast::ast::{Expression, IdentifierReference};
use oxc_semantic::{Semantic, SymbolFlags};

use super::path::{key_name, property, root};
use super::{Origin, Use};
use crate::check::{Confidence, Kind};
use crate::data::{FeatureId, instance_member_names, instance_members};
use crate::support::{SupportTable, TargetSupport};
use crate::targets::Targets;

pub fn detect(semantic: &Semantic<'_>, targets: &Targets) -> Vec<Use> {
    let mut declared = None;
    let mut uses = Vec::new();
    for node in semantic.nodes().iter() {
        let AstKind::CallExpression(call) = node.kind() else {
            continue;
        };
        let Expression::StaticMemberExpression(member) = call.callee.get_inner_expression() else {
            continue;
        };
        let name = member.property.name.as_str();
        // Most names have a supported member, so the decision goes first. It is a lookup in the targets.
        let Some(decision) = targets.method(name) else {
            continue;
        };
        // Few files call a candidate at all, so the declared names wait for the first candidate.
        if declared.get_or_insert_with(|| declared_names(semantic)).contains(name) {
            continue;
        }
        if receiver_is_module(semantic, &member.object) {
            continue;
        }
        uses.push(Use {
            alternatives: decision.alternatives,
            confidence: Confidence::Heuristic,
            ..Use::new(
                decision.feature,
                Kind::Builtin,
                Origin::Method,
                member.property.span,
                member.node_id(),
            )
        });
    }
    uses
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

/// A value that comes from a module: `require('x')`, `__webpack_require__(1)`, `import('x')`, and
/// those behind `.default`, `await` or an interop wrapper such as `__importDefault(require('x'))`.
/// A single-argument call counts only when its argument is itself a module expression.
fn is_module_expression(semantic: &Semantic<'_>, expression: &Expression<'_>) -> bool {
    match expression.get_inner_expression() {
        Expression::ImportExpression(_) => true,
        Expression::AwaitExpression(await_expression) => is_module_expression(semantic, &await_expression.argument),
        Expression::StaticMemberExpression(member) => is_module_expression(semantic, &member.object),
        Expression::ComputedMemberExpression(member) => is_module_expression(semantic, &member.object),
        Expression::CallExpression(call) => {
            let Expression::Identifier(callee) = call.callee.get_inner_expression() else {
                return false;
            };
            match callee.name.as_str() {
                "require" => return is_module_loader(semantic, callee),
                "__webpack_require__" => return true,
                _ => {}
            }
            matches!(call.arguments.as_slice(), [argument]
                if argument.as_expression().is_some_and(|argument| is_module_expression(semantic, argument)))
        }
        _ => false,
    }
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

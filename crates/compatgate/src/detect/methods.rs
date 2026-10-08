//! Calls of prototype methods by name: `.toSorted()`, `.union()`. Without types the receiver is
//! unknown, so the findings are heuristic. Three rules keep the noise down:
//! - a name that a supported member of any type also has (`.map()` of arrays) is skipped;
//! - a name that the file declares as a member (`class Q { union() {} }`) is skipped;
//! - a call on an imported module (`_.union()` of lodash, `R.take()` of Ramda) is skipped.

use std::collections::HashMap;

use oxc_ast::AstKind;
use oxc_ast::ast::{AssignmentTarget, Expression, IdentifierReference, PropertyKey};
use oxc_semantic::{Semantic, SymbolFlags};

use super::Use;
use crate::check::{Confidence, Kind};
use crate::data::{FeatureId, instance_members};
use crate::support::{Verdict, evaluate};
use crate::targets::Targets;

/// The feature of a finding and the other members with the same name.
type Decision = Option<(FeatureId, Vec<FeatureId>)>;

pub fn detect<'a>(semantic: &Semantic<'a>, targets: &Targets) -> Vec<Use> {
    let mut decisions = declared_names(semantic);
    let mut uses = Vec::new();
    for node in semantic.nodes().iter() {
        let AstKind::CallExpression(call) = node.kind() else {
            continue;
        };
        let Expression::StaticMemberExpression(member) = call.callee.get_inner_expression() else {
            continue;
        };
        let name = member.property.name.as_str();
        // Most names are skipped by the decision, and the decision is cached, so it goes before the receiver.
        let decision = decisions.entry(name).or_insert_with(|| decide(name, targets));
        let Some((feature, alternatives)) = decision else {
            continue;
        };
        if receiver_is_module(semantic, &member.object) {
            continue;
        }
        uses.push(Use {
            alternatives: alternatives.clone(),
            confidence: Confidence::Heuristic,
            keys: vec![format!("#{name}")],
            ..Use::new(*feature, Kind::Builtin, member.property.span, node.id())
        });
    }
    uses
}

/// Member names that the file declares: methods, fields and accessors of classes, keys of object literals,
/// and targets of `obj.name = …` and `obj['name'] = …`. A call of such a name most likely calls the code
/// of the file, so each name gets the decision to skip it. Ambient class members (`abstract take()`,
/// `declare take`) count on purpose: they declare a member of the file's own class and do not augment
/// builtins. Members of interfaces do not count.
fn declared_names<'a>(semantic: &Semantic<'a>) -> HashMap<&'a str, Decision> {
    let mut names = HashMap::new();
    for node in semantic.nodes().iter() {
        let name = match node.kind() {
            AstKind::MethodDefinition(method) => key_name(&method.key),
            AstKind::PropertyDefinition(property) => key_name(&property.key),
            AstKind::AccessorProperty(property) => key_name(&property.key),
            AstKind::ObjectProperty(property) => key_name(&property.key),
            AstKind::AssignmentExpression(assignment) => match &assignment.left {
                AssignmentTarget::StaticMemberExpression(member) => Some(member.property.name.as_str()),
                AssignmentTarget::ComputedMemberExpression(member) => match &member.expression {
                    Expression::StringLiteral(literal) => Some(literal.value.as_str()),
                    _ => None,
                },
                _ => None,
            },
            _ => None,
        };
        if let Some(name) = name {
            names.insert(name, None);
        }
    }
    names
}

/// `take` in `take() {}`, `take: f` and `'take': f`.
fn key_name<'a>(key: &PropertyKey<'a>) -> Option<&'a str> {
    match key {
        PropertyKey::StaticIdentifier(identifier) => Some(identifier.name.as_str()),
        PropertyKey::StringLiteral(literal) => Some(literal.value.as_str()),
        _ => None,
    }
}

fn decide(name: &str, targets: &Targets) -> Decision {
    let mut candidates = Vec::new();
    // `instance_members` yields the members in the order of their ids: the data is sorted by name
    // and feature index, and the features are sorted by id. Tests in `data` check both orders.
    for (feature, reportable) in instance_members(name) {
        let verdict = evaluate(feature, targets);
        if verdict == Verdict::Supported {
            return None;
        }
        if reportable {
            candidates.push((feature, verdict));
        }
    }
    choose(candidates)
}

/// The call may be any of the candidates, so the finding names the one with the worst verdict:
/// `Unsupported` before `Partial`. Ties go to the first candidate. The candidates come in the order of their ids.
fn choose(candidates: Vec<(FeatureId, Verdict)>) -> Decision {
    let severity = |verdict: &Verdict| match verdict {
        Verdict::Supported => 0,
        Verdict::Partial(_) => 1,
        Verdict::Unsupported(_) => 2,
    };
    let mut worst = 0;
    for (index, (_, verdict)) in candidates.iter().enumerate() {
        if severity(verdict) > severity(&candidates[worst].1) {
            worst = index;
        }
    }
    let feature = candidates.get(worst)?.0;
    let alternatives = candidates
        .iter()
        .enumerate()
        .filter(|&(index, _)| index != worst)
        .map(|(_, &(feature, _))| feature)
        .collect();
    Some((feature, alternatives))
}

/// `_.union()` with `import _ from 'lodash'` or `const _ = require('lodash')` calls a module function.
fn receiver_is_module(semantic: &Semantic<'_>, object: &Expression<'_>) -> bool {
    let mut current = object.get_inner_expression();
    let identifier = loop {
        match current {
            Expression::Identifier(identifier) => break identifier,
            Expression::StaticMemberExpression(member) => current = member.object.get_inner_expression(),
            Expression::ComputedMemberExpression(member) => current = member.object.get_inner_expression(),
            _ => return is_module_expression(semantic, current),
        }
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

    fn feature(id: &str) -> FeatureId {
        FeatureId::find(id).unwrap()
    }

    #[test]
    fn the_finding_names_the_candidate_with_the_worst_verdict() {
        // In BCD 8.1.4 no method that a finding may name has partial support in any browser,
        // so no name has candidates with different verdicts. The verdicts here are built by hand.
        let first = feature("javascript.builtins.Array.toSorted");
        let second = feature("javascript.builtins.TypedArray.toSorted");
        let partial = || Verdict::Partial(Vec::new());
        let unsupported = || Verdict::Unsupported(Vec::new());
        assert_eq!(
            choose(vec![(first, partial()), (second, unsupported())]),
            Some((second, vec![first]))
        );
        assert_eq!(
            choose(vec![(first, unsupported()), (second, partial())]),
            Some((first, vec![second]))
        );
        assert_eq!(
            choose(vec![(first, unsupported()), (second, unsupported())]),
            Some((first, vec![second]))
        );
        assert_eq!(
            choose(vec![(first, partial()), (second, partial())]),
            Some((first, vec![second]))
        );
        assert_eq!(choose(Vec::new()), None);
    }
}

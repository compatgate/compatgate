//! Calls of prototype methods by name: `.toSorted()`, `.union()`. Without types the receiver is
//! unknown, so the findings are heuristic. Two rules keep the noise down:
//! - a name that a supported member of any type also has (`.map()` of arrays) is skipped;
//! - a call on an imported module (`_.union()` of lodash, `R.take()` of Ramda) is skipped.

use std::collections::HashMap;

use oxc_ast::AstKind;
use oxc_ast::ast::Expression;
use oxc_semantic::{Semantic, SymbolFlags};

use super::Use;
use crate::check::{Confidence, Kind};
use crate::data::{FeatureId, instance_members};
use crate::support::{Verdict, evaluate};
use crate::targets::Targets;

pub fn detect(semantic: &Semantic<'_>, targets: &Targets) -> Vec<Use> {
    let mut decisions: HashMap<String, Option<(FeatureId, Vec<FeatureId>)>> = HashMap::new();
    let mut uses = Vec::new();
    for node in semantic.nodes().iter() {
        let AstKind::CallExpression(call) = node.kind() else {
            continue;
        };
        let Expression::StaticMemberExpression(member) = call.callee.get_inner_expression() else {
            continue;
        };
        let name = member.property.name.as_str();
        if receiver_is_module(semantic, &member.object) {
            continue;
        }
        let decision = decisions
            .entry(name.to_string())
            .or_insert_with(|| decide(name, targets));
        let Some((feature, alternatives)) = decision else {
            continue;
        };
        uses.push(Use {
            alternatives: alternatives.clone(),
            confidence: Confidence::Heuristic,
            keys: vec![format!("#{name}")],
            ..Use::new(*feature, Kind::Builtin, member.property.span, node.id())
        });
    }
    uses
}

fn decide(name: &str, targets: &Targets) -> Option<(FeatureId, Vec<FeatureId>)> {
    let members: Vec<(FeatureId, bool)> = instance_members(name).collect();
    if members
        .iter()
        .any(|&(feature, _)| evaluate(feature, targets) == Verdict::Supported)
    {
        return None;
    }
    let mut candidates: Vec<FeatureId> = members
        .into_iter()
        .filter(|&(_, reportable)| reportable)
        .map(|(feature, _)| feature)
        .collect();
    candidates.sort_by_key(|feature| feature.as_str());
    let (first, rest) = candidates.split_first()?;
    Some((*first, rest.to_vec()))
}

/// `_.union()` with `import _ from 'lodash'` or `const _ = require('lodash')` calls a module function.
fn receiver_is_module(semantic: &Semantic<'_>, object: &Expression<'_>) -> bool {
    let mut current = object.get_inner_expression();
    let identifier = loop {
        match current {
            Expression::Identifier(identifier) => break identifier,
            Expression::StaticMemberExpression(member) => current = member.object.get_inner_expression(),
            Expression::ComputedMemberExpression(member) => current = member.object.get_inner_expression(),
            _ => return is_module_expression(current),
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
        AstKind::VariableDeclarator(declarator) if declarator.init.as_ref().is_some_and(is_module_expression)
    )
}

/// A value that comes from a module: `require('x')`, `__webpack_require__(1)`, `import('x')`, and
/// those behind `.default`, `await` or an interop wrapper such as `__importDefault(require('x'))`.
/// A single-argument call counts only when its argument is itself a module expression.
fn is_module_expression(expression: &Expression<'_>) -> bool {
    match expression.get_inner_expression() {
        Expression::ImportExpression(_) => true,
        Expression::AwaitExpression(await_expression) => is_module_expression(&await_expression.argument),
        Expression::StaticMemberExpression(member) => is_module_expression(&member.object),
        Expression::ComputedMemberExpression(member) => is_module_expression(&member.object),
        Expression::CallExpression(call) => {
            let Expression::Identifier(callee) = call.callee.get_inner_expression() else {
                return false;
            };
            if matches!(callee.name.as_str(), "require" | "__webpack_require__") {
                return true;
            }
            matches!(call.arguments.as_slice(), [argument]
                if argument.as_expression().is_some_and(is_module_expression))
        }
        _ => false,
    }
}

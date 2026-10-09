//! Aliases: a variable that holds the value of one expression wherever it holds a value at all. The
//! guards follow the value of a use into its alias, and read a check of the alias as a check of the
//! expression.
//!
//! An alias is a `const`, a `let` or `var` with an initializer and no writes, or a `let` or `var` without
//! an initializer that the code writes once with `y = X`. Downleveled optional chains write such a
//! temporary variable: `null == (t = X) ? void 0 : t.y`. Before its write the variable is `undefined`, and
//! a check of it is false there, so a check of the alias proves the expression present wherever the code
//! reads it. A variable with another write, a parameter, a loop variable of `for … of` and `for … in`, and
//! an exported variable are no aliases.
//!
//! Some writes are no references. The scripts of a page share their top-level names, so another script
//! may write a top-level `var` or `let` of a script; a top-level `const` stays an alias, since nothing
//! writes a `const`. oxc cannot tell a script of a page from CommonJS, whose top level is private, so the
//! rule costs only the aliases of CommonJS. A direct `eval` may write any variable that it sees, and in
//! sloppy code a function declared in a block writes the `var` of its name, and a name in the body of
//! `with` may be a property of its object. Such variables are no aliases either.

use std::collections::{HashMap, HashSet};

use oxc_ast::AstKind;
use oxc_ast::ast::{AssignmentOperator, AssignmentTarget, BindingPattern, Expression, VariableDeclarationKind};
use oxc_semantic::{NodeId, ScopeFlags, ScopeId, Semantic, SymbolFlags, SymbolId};
use oxc_span::GetSpan;

use super::path::key_name;

/// The value that an alias holds.
#[derive(Clone, Copy)]
pub enum Alias<'a> {
    /// `X` in `const y = X` and in `var y; y = X`.
    Value(&'a Expression<'a>),
    /// `X` and `p` in `const { p: y } = X`: the member `p` of `X`.
    Member(&'a Expression<'a>, &'a str),
}

/// The aliases of a file, found once per variable.
pub struct Aliases<'s, 'a> {
    semantic: &'s Semantic<'a>,
    known: HashMap<SymbolId, Option<Alias<'a>>>,
    /// The writes of sloppy code that are no references, found once per file on the first question.
    sloppy: Option<Sloppy<'s>>,
}

/// Where sloppy code may write a variable without a reference to it.
struct Sloppy<'s> {
    /// The functions declared in a block of a script, by name and by the scope of the function around
    /// the block: each writes the `var` of its name there.
    block_functions: HashSet<(&'s str, ScopeId)>,
    /// The script has a `with`: a name in its body may be a property of its object.
    with: bool,
}

impl<'s, 'a> Aliases<'s, 'a> {
    pub fn new(semantic: &'s Semantic<'a>) -> Self {
        Self {
            semantic,
            known: HashMap::new(),
            sloppy: None,
        }
    }

    /// The value of the variable `symbol`, when it is an alias.
    pub fn get(&mut self, symbol: SymbolId) -> Option<Alias<'a>> {
        if let Some(&alias) = self.known.get(&symbol) {
            return alias;
        }
        let alias = self.find(symbol);
        self.known.insert(symbol, alias);
        alias
    }

    /// The alias that the expression at `node` is the value of: `y` in `const y = X` and in `y = X`.
    pub fn stored_into(&mut self, node: NodeId) -> Option<SymbolId> {
        let nodes = self.semantic.nodes();
        let span = nodes.kind(node).span();
        let symbol = match nodes.parent_kind(node) {
            AstKind::VariableDeclarator(declarator)
                if declarator.init.as_ref().is_some_and(|init| init.span() == span) =>
            {
                let BindingPattern::BindingIdentifier(binding) = &declarator.id else {
                    return None;
                };
                binding.symbol_id()
            }
            AstKind::AssignmentExpression(assignment)
                if assignment.operator == AssignmentOperator::Assign && assignment.right.span() == span =>
            {
                let AssignmentTarget::AssignmentTargetIdentifier(target) = &assignment.left else {
                    return None;
                };
                self.semantic
                    .scoping()
                    .get_reference(target.reference_id())
                    .symbol_id()?
            }
            _ => return None,
        };
        self.get(symbol).map(|_| symbol)
    }

    /// The alias that a destructured property binds: `y` in `const { p: y } = X`.
    pub fn bound_by(&mut self, property: &BindingPattern<'a>) -> Option<SymbolId> {
        let BindingPattern::BindingIdentifier(binding) = property else {
            return None;
        };
        let symbol = binding.symbol_id();
        self.get(symbol).map(|_| symbol)
    }

    /// The nodes where the code reads the variable at run time.
    pub fn reads(&self, symbol: SymbolId) -> Vec<NodeId> {
        self.semantic
            .scoping()
            .get_resolved_references(symbol)
            .filter(|reference| reference.is_read() && !reference.flags().is_value_as_type())
            .map(|reference| reference.node_id())
            .collect()
    }

    fn find(&mut self, symbol: SymbolId) -> Option<Alias<'a>> {
        let semantic = self.semantic;
        let scoping = semantic.scoping();
        let nodes = semantic.nodes();
        let flags = scoping.symbol_flags(symbol);
        if !flags.intersects(SymbolFlags::Variable)
            || !(SymbolFlags::Variable | SymbolFlags::ConstVariable).contains(flags)
            || !scoping.symbol_redeclarations(symbol).is_empty()
        {
            return None;
        }
        let id = scoping.symbol_declaration(symbol);
        let AstKind::VariableDeclarator(declarator) = nodes.kind(id) else {
            return None;
        };
        let declaration = nodes.parent_id(id);
        let AstKind::VariableDeclaration(statement) = nodes.kind(declaration) else {
            return None;
        };
        let kind = statement.kind;
        if !matches!(
            kind,
            VariableDeclarationKind::Var | VariableDeclarationKind::Let | VariableDeclarationKind::Const
        ) {
            return None;
        }
        // The loop writes its items into a loop variable, and other modules read an exported one.
        if matches!(
            nodes.parent_kind(declaration),
            AstKind::ForInStatement(_) | AstKind::ForOfStatement(_) | AstKind::ExportDeclaration(_)
        ) {
            return None;
        }
        // The scripts of a page share their top-level names, and another script may write them.
        let scope = scoping.symbol_scope_id(symbol);
        if !semantic.source_type().is_module()
            && kind != VariableDeclarationKind::Const
            && scope == scoping.root_scope_id()
        {
            return None;
        }
        // oxc marks a scope with a direct `eval` and every scope around it. `eval` cannot write a `const`.
        if kind != VariableDeclarationKind::Const && scoping.scope_flags(scope).contains_direct_eval() {
            return None;
        }
        let sloppy = self.sloppy.get_or_insert_with(|| sloppy(semantic));
        if (kind == VariableDeclarationKind::Var
            && sloppy.block_functions.contains(&(scoping.symbol_name(symbol), scope)))
            || (sloppy.with
                && scoping.get_resolved_references(symbol).any(|reference| {
                    scoping
                        .scope_ancestors(reference.scope_id())
                        .take_while(|&ancestor| ancestor != scope)
                        .any(|ancestor| scoping.scope_flags(ancestor).contains(ScopeFlags::With))
                }))
        {
            return None;
        }
        let mut writes = scoping
            .get_resolved_references(symbol)
            .filter(|reference| reference.is_write());
        let write = writes.next();
        if writes.next().is_some() {
            return None;
        }
        match (&declarator.id, &declarator.init, write) {
            (BindingPattern::BindingIdentifier(_), Some(init), None) => Some(Alias::Value(init)),
            (BindingPattern::BindingIdentifier(_), None, Some(write)) if !write.is_read() => {
                let target = write.node_id();
                match nodes.parent_kind(target) {
                    AstKind::AssignmentExpression(assignment)
                        if assignment.operator == AssignmentOperator::Assign
                            && assignment.left.span() == nodes.kind(target).span() =>
                    {
                        Some(Alias::Value(&assignment.right))
                    }
                    _ => None,
                }
            }
            (BindingPattern::ObjectPattern(pattern), Some(init), None) => {
                let property = pattern.properties.iter().find(|property| {
                    matches!(&property.value, BindingPattern::BindingIdentifier(binding) if binding.symbol_id() == symbol)
                })?;
                Some(Alias::Member(init, key_name(&property.key)?))
            }
            _ => None,
        }
    }
}

/// The writes of sloppy code that are no references: functions declared in blocks of a script and the
/// bodies of `with`. Modules are strict, so they have neither. One pass over the scopes finds both.
fn sloppy<'s>(semantic: &'s Semantic<'_>) -> Sloppy<'s> {
    let scoping = semantic.scoping();
    let mut found = Sloppy {
        block_functions: HashSet::new(),
        with: false,
    };
    if semantic.source_type().is_module() {
        return found;
    }
    for block in scoping.scope_descendants_from_root() {
        let flags = scoping.scope_flags(block);
        found.with |= flags.contains(ScopeFlags::With);
        if flags.is_var() {
            continue;
        }
        for &symbol in scoping.get_bindings(block).values() {
            let symbol_flags = scoping.symbol_flags(symbol);
            if symbol_flags.contains(SymbolFlags::Function)
                && !symbol_flags.contains(SymbolFlags::FunctionExpression)
                && let Some(function) = scoping
                    .scope_ancestors(block)
                    .find(|&scope| scoping.scope_flags(scope).is_var())
            {
                found.block_functions.insert((scoping.symbol_name(symbol), function));
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::check::with_semantic;

    /// Whether the first variable of each name in `names` is an alias in `source`.
    fn aliases(source: &str, filename: &str, names: &[&str]) -> Vec<bool> {
        with_semantic(source, filename, |semantic, _| {
            let scoping = semantic.scoping();
            let mut aliases = Aliases::new(semantic);
            names
                .iter()
                .map(|name| {
                    let symbol = scoping
                        .symbol_ids()
                        .find(|&symbol| scoping.symbol_name(symbol) == *name)
                        .unwrap();
                    aliases.get(symbol).is_some()
                })
                .collect()
        })
        .unwrap()
    }

    #[test]
    fn a_variable_with_one_value_is_an_alias() {
        let source = "function f() { const a = x; let b = x; var c = x; var d; d = x; const { p: e } = x; }";
        assert_eq!(
            aliases(source, "a.js", &["a", "b", "c", "d", "e"]),
            [true, true, true, true, true]
        );
    }

    #[test]
    fn a_variable_with_another_write_is_no_alias() {
        let source =
            "function f(a) { a = x; let b = x; b = y; var c; c = x; c = y; var d; d += x; for (var e of l) {} }";
        assert_eq!(
            aliases(source, "a.js", &["a", "b", "c", "d", "e"]),
            [false, false, false, false, false]
        );
    }

    #[test]
    fn a_top_level_var_of_a_script_is_no_alias_but_a_const_is() {
        let source = "var a = x; let b = x; const c = x;";
        assert_eq!(aliases(source, "a.js", &["a", "b", "c"]), [false, false, true]);
        let module = "var a = x; let b = x; const c = x; export {};";
        assert_eq!(aliases(module, "a.js", &["a", "b", "c"]), [true, true, true]);
    }

    #[test]
    fn a_variable_that_sloppy_code_writes_without_a_reference_is_no_alias() {
        // The `var` comes first among the symbols named `a`; the block function has a symbol of its own.
        let block = "function f() { var a = x; { function a() {} } var b = x; } function g() { var c = x; }";
        assert_eq!(aliases(block, "a.js", &["a", "b", "c"]), [false, true, true]);
        let with = "var b = x; function f(o) { var a = x; with (o) { a; } } function g() { const c = x; c; }";
        assert_eq!(aliases(with, "a.js", &["a", "c"]), [false, true]);
        let eval = "function f() { var a = x; const b = x; eval(''); } function g() { var c = x; }";
        assert_eq!(aliases(eval, "a.js", &["a", "b", "c"]), [false, true, true]);
    }
}

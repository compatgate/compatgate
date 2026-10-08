//! Syntax that needs a newer browser: `??=`, class fields, `#x in obj` and the like.
//! BCD names syntax in words, so a hand-written table maps AST nodes to BCD keys.
//! The completeness test makes sure that every BCD syntax key has a decision.

use oxc_ast::AstKind;
use oxc_ast::ast::{
    AssignmentOperator, BigintBase, BinaryOperator, BindingPattern, ClassType, FunctionType, LogicalOperator,
    MethodDefinitionKind, MethodDefinitionType, NumberBase, PropertyDefinitionType, PropertyKey, PropertyKind,
    UpdateOperator, VariableDeclarationKind,
};
use oxc_semantic::{AstNodes, NodeId, Semantic};
use oxc_span::{GetSpan, Span};

use super::{Origin, Use};
use crate::check::Kind;
use crate::data::FeatureId;
use crate::targets::Targets;

mod key {
    use crate::data::FeatureId;

    pub const BINARY_LITERALS: FeatureId = FeatureId::known("javascript.grammar.binary_numeric_literals");
    pub const NUMERIC_SEPARATORS: FeatureId = FeatureId::known("javascript.grammar.numeric_separators");
    pub const OCTAL_LITERALS: FeatureId = FeatureId::known("javascript.grammar.octal_numeric_literals");
    pub const TEMPLATE_LITERALS: FeatureId = FeatureId::known("javascript.grammar.template_literals");
    pub const TEMPLATE_REVISION: FeatureId =
        FeatureId::known("javascript.grammar.template_literals.template_literal_revision");
    pub const TRAILING_COMMAS: FeatureId =
        FeatureId::known("javascript.grammar.trailing_commas.trailing_commas_in_functions");
    pub const UNICODE_POINT_ESCAPES: FeatureId = FeatureId::known("javascript.grammar.unicode_point_escapes");
    pub const ASYNC_FUNCTION_EXPRESSION: FeatureId = FeatureId::known("javascript.operators.async_function");
    pub const ASYNC_GENERATOR_EXPRESSION: FeatureId = FeatureId::known("javascript.operators.async_generator_function");
    pub const AWAIT: FeatureId = FeatureId::known("javascript.operators.await");
    pub const CLASS_EXPRESSION: FeatureId = FeatureId::known("javascript.operators.class");
    pub const DECREMENT: FeatureId = FeatureId::known("javascript.operators.decrement");
    pub const INCREMENT: FeatureId = FeatureId::known("javascript.operators.increment");
    pub const DESTRUCTURING: FeatureId = FeatureId::known("javascript.operators.destructuring");
    pub const DESTRUCTURING_COMPUTED: FeatureId =
        FeatureId::known("javascript.operators.destructuring.computed_property_names");
    pub const REST_IN_ARRAYS: FeatureId = FeatureId::known("javascript.operators.destructuring.rest_in_arrays");
    pub const REST_IN_OBJECTS: FeatureId = FeatureId::known("javascript.operators.destructuring.rest_in_objects");
    pub const EXPONENTIATION: FeatureId = FeatureId::known("javascript.operators.exponentiation");
    pub const EXPONENTIATION_ASSIGNMENT: FeatureId = FeatureId::known("javascript.operators.exponentiation_assignment");
    pub const GENERATOR_EXPRESSION: FeatureId = FeatureId::known("javascript.operators.generator_function");
    pub const LOGICAL_AND_ASSIGNMENT: FeatureId = FeatureId::known("javascript.operators.logical_and_assignment");
    pub const LOGICAL_OR_ASSIGNMENT: FeatureId = FeatureId::known("javascript.operators.logical_or_assignment");
    pub const NEW_TARGET: FeatureId = FeatureId::known("javascript.operators.new_target");
    pub const NULLISH: FeatureId = FeatureId::known("javascript.operators.nullish_coalescing");
    pub const NULLISH_ASSIGNMENT: FeatureId = FeatureId::known("javascript.operators.nullish_coalescing_assignment");
    pub const COMPUTED_PROPERTIES: FeatureId =
        FeatureId::known("javascript.operators.object_initializer.computed_property_names");
    pub const SHORTHAND_METHODS: FeatureId =
        FeatureId::known("javascript.operators.object_initializer.shorthand_method_names");
    pub const SHORTHAND_PROPERTIES: FeatureId =
        FeatureId::known("javascript.operators.object_initializer.shorthand_property_names");
    pub const OPTIONAL_CHAINING: FeatureId = FeatureId::known("javascript.operators.optional_chaining");
    pub const SPREAD_IN_ARRAYS: FeatureId = FeatureId::known("javascript.operators.spread.spread_in_arrays");
    pub const SPREAD_IN_CALLS: FeatureId = FeatureId::known("javascript.operators.spread.spread_in_function_calls");
    pub const SPREAD_IN_OBJECTS: FeatureId = FeatureId::known("javascript.operators.spread.spread_in_object_literals");
    pub const SUPER: FeatureId = FeatureId::known("javascript.operators.super");
    pub const YIELD: FeatureId = FeatureId::known("javascript.operators.yield");
    pub const YIELD_STAR: FeatureId = FeatureId::known("javascript.operators.yield_star");
    pub const ASYNC_FUNCTION_DECLARATION: FeatureId = FeatureId::known("javascript.statements.async_function");
    pub const ASYNC_GENERATOR_DECLARATION: FeatureId =
        FeatureId::known("javascript.statements.async_generator_function");
    pub const AWAIT_USING: FeatureId = FeatureId::known("javascript.statements.await_using");
    pub const CLASS_DECLARATION: FeatureId = FeatureId::known("javascript.statements.class");
    pub const CONST: FeatureId = FeatureId::known("javascript.statements.const");
    pub const DEBUGGER: FeatureId = FeatureId::known("javascript.statements.debugger");
    pub const EMPTY: FeatureId = FeatureId::known("javascript.statements.empty");
    pub const FOR_AWAIT_OF: FeatureId = FeatureId::known("javascript.statements.for_await_of");
    pub const FOR_OF: FeatureId = FeatureId::known("javascript.statements.for_of");
    pub const GENERATOR_DECLARATION: FeatureId = FeatureId::known("javascript.statements.generator_function");
    pub const LET: FeatureId = FeatureId::known("javascript.statements.let");
    pub const OPTIONAL_CATCH_BINDING: FeatureId =
        FeatureId::known("javascript.statements.try_catch.optional_catch_binding");
    pub const USING: FeatureId = FeatureId::known("javascript.statements.using");
    pub const CONSTRUCTOR: FeatureId = FeatureId::known("javascript.classes.constructor");
    pub const EXTENDS: FeatureId = FeatureId::known("javascript.classes.extends");
    pub const PRIVATE_FIELDS: FeatureId = FeatureId::known("javascript.classes.private_class_fields");
    pub const PRIVATE_IN: FeatureId = FeatureId::known("javascript.classes.private_class_fields_in");
    pub const PRIVATE_METHODS: FeatureId = FeatureId::known("javascript.classes.private_class_methods");
    pub const PUBLIC_FIELDS: FeatureId = FeatureId::known("javascript.classes.public_class_fields");
    pub const STATIC_MEMBERS: FeatureId = FeatureId::known("javascript.classes.static");
    pub const STATIC_FIELDS: FeatureId = FeatureId::known("javascript.classes.static.class_fields");
    pub const STATIC_BLOCKS: FeatureId = FeatureId::known("javascript.classes.static.initialization_blocks");
    pub const ARROW_FUNCTIONS: FeatureId = FeatureId::known("javascript.functions.arrow_functions");
    pub const BLOCK_LEVEL_FUNCTIONS: FeatureId = FeatureId::known("javascript.functions.block_level_functions");
    pub const DEFAULT_PARAMETERS: FeatureId = FeatureId::known("javascript.functions.default_parameters");
    pub const DESTRUCTURED_DEFAULTS: FeatureId = FeatureId::known(
        "javascript.functions.default_parameters.destructured_parameter_with_default_value_assignment",
    );
    pub const PARAMETERS_AFTER_DEFAULTS: FeatureId = FeatureId::known(
        "javascript.functions.default_parameters.parameters_without_defaults_after_default_parameters",
    );
    pub const GET_COMPUTED: FeatureId = FeatureId::known("javascript.functions.get.computed_property_names");
    pub const SET_COMPUTED: FeatureId = FeatureId::known("javascript.functions.set.computed_property_names");
    pub const METHOD_DEFINITIONS: FeatureId = FeatureId::known("javascript.functions.method_definitions");
    pub const ASYNC_GENERATOR_METHODS: FeatureId =
        FeatureId::known("javascript.functions.method_definitions.async_generator_methods");
    pub const ASYNC_METHODS: FeatureId = FeatureId::known("javascript.functions.method_definitions.async_methods");
    pub const REST_PARAMETERS: FeatureId = FeatureId::known("javascript.functions.rest_parameters");
    pub const REST_DESTRUCTURING: FeatureId = FeatureId::known("javascript.functions.rest_parameters.destructuring");
    pub const BIGINT: FeatureId = FeatureId::known("javascript.builtins.BigInt");
}

/// Every key the detector can report. A test checks that each one has a sample that triggers it.
// Read by the completeness tests of the syntax and regex detectors.
#[allow(dead_code)]
pub const EMITTED: &[FeatureId] = &[
    key::BINARY_LITERALS,
    key::NUMERIC_SEPARATORS,
    key::OCTAL_LITERALS,
    key::TEMPLATE_LITERALS,
    key::TEMPLATE_REVISION,
    key::TRAILING_COMMAS,
    key::UNICODE_POINT_ESCAPES,
    key::ASYNC_FUNCTION_EXPRESSION,
    key::ASYNC_GENERATOR_EXPRESSION,
    key::AWAIT,
    key::CLASS_EXPRESSION,
    key::DECREMENT,
    key::INCREMENT,
    key::DESTRUCTURING,
    key::DESTRUCTURING_COMPUTED,
    key::REST_IN_ARRAYS,
    key::REST_IN_OBJECTS,
    key::EXPONENTIATION,
    key::EXPONENTIATION_ASSIGNMENT,
    key::GENERATOR_EXPRESSION,
    key::LOGICAL_AND_ASSIGNMENT,
    key::LOGICAL_OR_ASSIGNMENT,
    key::NEW_TARGET,
    key::NULLISH,
    key::NULLISH_ASSIGNMENT,
    key::COMPUTED_PROPERTIES,
    key::SHORTHAND_METHODS,
    key::SHORTHAND_PROPERTIES,
    key::OPTIONAL_CHAINING,
    key::SPREAD_IN_ARRAYS,
    key::SPREAD_IN_CALLS,
    key::SPREAD_IN_OBJECTS,
    key::SUPER,
    key::YIELD,
    key::YIELD_STAR,
    key::ASYNC_FUNCTION_DECLARATION,
    key::ASYNC_GENERATOR_DECLARATION,
    key::AWAIT_USING,
    key::CLASS_DECLARATION,
    key::CONST,
    key::DEBUGGER,
    key::EMPTY,
    key::FOR_AWAIT_OF,
    key::FOR_OF,
    key::GENERATOR_DECLARATION,
    key::LET,
    key::OPTIONAL_CATCH_BINDING,
    key::USING,
    key::CONSTRUCTOR,
    key::EXTENDS,
    key::PRIVATE_FIELDS,
    key::PRIVATE_IN,
    key::PRIVATE_METHODS,
    key::PUBLIC_FIELDS,
    key::STATIC_MEMBERS,
    key::STATIC_FIELDS,
    key::STATIC_BLOCKS,
    key::ARROW_FUNCTIONS,
    key::BLOCK_LEVEL_FUNCTIONS,
    key::DEFAULT_PARAMETERS,
    key::DESTRUCTURED_DEFAULTS,
    key::PARAMETERS_AFTER_DEFAULTS,
    key::GET_COMPUTED,
    key::SET_COMPUTED,
    key::METHOD_DEFINITIONS,
    key::ASYNC_GENERATOR_METHODS,
    key::ASYNC_METHODS,
    key::REST_PARAMETERS,
    key::REST_DESTRUCTURING,
    key::BIGINT,
];

/// Keys that describe the same syntax as an emitted key, or group several emitted keys.
// Read by the completeness tests of the syntax and regex detectors.
#[allow(dead_code)]
pub const ALIASES: &[(&str, FeatureId)] = &[
    (
        "javascript.grammar.shorthand_object_literals",
        key::SHORTHAND_PROPERTIES,
    ),
    (
        "javascript.operators.object_initializer.spread_properties",
        key::SPREAD_IN_OBJECTS,
    ),
    ("javascript.operators.spread", key::SPREAD_IN_ARRAYS),
    ("javascript.classes", key::CLASS_DECLARATION),
    ("javascript.operators.function.trailing_comma", key::TRAILING_COMMAS),
    (
        "javascript.operators.generator_function.trailing_comma",
        key::TRAILING_COMMAS,
    ),
    (
        "javascript.statements.function.trailing_comma_in_parameters",
        key::TRAILING_COMMAS,
    ),
    (
        "javascript.statements.generator_function.trailing_comma_in_parameters",
        key::TRAILING_COMMAS,
    ),
    (
        "javascript.functions.arrow_functions.trailing_comma",
        key::TRAILING_COMMAS,
    ),
];

const MODULES: &str = "module syntax: a bundler replaces it with its own code before the code reaches the browser";
const BEHAVIOR: &str = "runtime behavior, not syntax: the code does not show it without type information";

/// Why the detector does not report a syntax key. `None` means the key needs a detector or an alias.
// Only the completeness tests of the syntax and regex detectors call it. `MODULES` and `BEHAVIOR`
// are read only here, so the expectation covers them too.
#[cfg_attr(not(test), expect(dead_code))]
pub fn untracked_reason(key: &str) -> Option<&'static str> {
    const MODULE_PREFIXES: [&str; 5] = [
        "javascript.statements.import",
        "javascript.statements.export",
        "javascript.operators.import",
        "javascript.operators.await.top_level",
        "javascript.grammar.trailing_commas.trailing_commas_in_dynamic_import",
    ];
    const BEHAVIOR_KEYS: [&str; 6] = [
        "javascript.statements.for_of.async_iterators",
        "javascript.statements.for_of.closing_iterators",
        "javascript.statements.generator_function.IteratorResult_object",
        "javascript.statements.generator_function.not_constructable_with_new",
        "javascript.functions.method_definitions.generator_methods_not_constructable",
        "javascript.functions.arguments.@@iterator",
    ];
    if MODULE_PREFIXES.iter().any(|prefix| key.starts_with(prefix)) {
        Some(MODULES)
    } else if BEHAVIOR_KEYS.contains(&key) {
        Some(BEHAVIOR)
    } else if key == "javascript.regular_expressions.buffer_boundary_assertion" {
        Some("a proposal that oxc does not parse yet")
    } else if key == "javascript.grammar.hashbang_comments" {
        Some("a hashbang line is stripped by Node and bundlers; browsers never see it")
    } else {
        None
    }
}

/// Supported by the oldest version that caniuse knows of every major browser. Such syntax needs no check.
#[cfg(test)]
pub(crate) fn ancient(key: &str) -> bool {
    use crate::data::{Browser, encode_version};
    let feature = FeatureId::find(key).unwrap();
    [
        (Browser::Chrome, "4"),
        (Browser::Firefox, "2"),
        (Browser::Safari, "3.1"),
        (Browser::SafariIos, "3.2"),
    ]
    .iter()
    .all(|&(browser, version)| feature.full_support(browser) <= encode_version(version).unwrap())
}

/// `ambient` comes from `ambient_nodes`. `check` computes it once per file for all detectors.
/// Syntax that the targets support is no use: most nodes of a modern file are such syntax.
pub fn detect<'t>(semantic: &Semantic<'_>, ambient: &[bool], targets: &Targets) -> Vec<Use<'t>> {
    // Everything in a declaration file is ambient, `export` without `declare` included.
    if semantic.source_type().is_typescript_definition() {
        return Vec::new();
    }
    let nodes = semantic.nodes();
    let source = semantic.source_text();
    let mut uses = Vec::new();
    for node in nodes.iter() {
        let id = node.id();
        if ambient[id.index()] {
            continue;
        }
        let mut add = |feature: FeatureId, span: Span| push(&mut uses, targets, feature, Kind::Syntax, span, id);
        match node.kind() {
            AstKind::NumericLiteral(it) => {
                let raw = it.raw.as_ref().map_or("", |raw| raw.as_str());
                numeric(
                    &mut add,
                    raw,
                    it.base == NumberBase::Binary,
                    it.base == NumberBase::Octal,
                    it.span,
                );
            }
            AstKind::BigIntLiteral(it) => {
                let raw = it.raw.as_ref().map_or("", |raw| raw.as_str());
                numeric(
                    &mut add,
                    raw,
                    it.base == BigintBase::Binary,
                    it.base == BigintBase::Octal,
                    it.span,
                );
                push(&mut uses, targets, key::BIGINT, Kind::Builtin, it.span, id);
            }
            AstKind::StringLiteral(it) => {
                if it.raw.as_ref().is_some_and(|raw| has_code_point_escape(raw.as_str())) {
                    add(key::UNICODE_POINT_ESCAPES, it.span);
                }
            }
            AstKind::TemplateElement(it) => {
                if has_code_point_escape(it.value.raw.as_str()) {
                    add(key::UNICODE_POINT_ESCAPES, it.span);
                }
            }
            AstKind::TemplateLiteral(it) => add(key::TEMPLATE_LITERALS, it.span),
            AstKind::TaggedTemplateExpression(it) => {
                if it.quasi.quasis.iter().any(|quasi| quasi.value.cooked.is_none()) {
                    add(key::TEMPLATE_REVISION, it.span);
                }
            }
            AstKind::ObjectProperty(it) => match it.kind {
                PropertyKind::Init => {
                    if it.shorthand {
                        add(key::SHORTHAND_PROPERTIES, it.span);
                    }
                    if it.method {
                        add(key::SHORTHAND_METHODS, it.span);
                        add(key::METHOD_DEFINITIONS, it.span);
                    }
                    if it.computed {
                        add(key::COMPUTED_PROPERTIES, it.span);
                    }
                }
                PropertyKind::Get if it.computed => add(key::GET_COMPUTED, it.span),
                PropertyKind::Set if it.computed => add(key::SET_COMPUTED, it.span),
                _ => {}
            },
            AstKind::SpreadElement(it) => match nodes.parent_kind(id) {
                AstKind::ArrayExpression(_) => add(key::SPREAD_IN_ARRAYS, it.span),
                AstKind::ObjectExpression(_) => add(key::SPREAD_IN_OBJECTS, it.span),
                AstKind::CallExpression(_) | AstKind::NewExpression(_) => add(key::SPREAD_IN_CALLS, it.span),
                _ => {}
            },
            AstKind::CallExpression(it) => {
                if it
                    .arguments
                    .last()
                    .is_some_and(|last| trailing_comma(source, last.span().end))
                {
                    add(key::TRAILING_COMMAS, it.span);
                }
            }
            AstKind::NewExpression(it) => {
                if it
                    .arguments
                    .last()
                    .is_some_and(|last| trailing_comma(source, last.span().end))
                {
                    add(key::TRAILING_COMMAS, it.span);
                }
            }
            AstKind::ArrowFunctionExpression(it) => {
                add(key::ARROW_FUNCTIONS, it.span);
                if it.r#async {
                    add(key::ASYNC_FUNCTION_EXPRESSION, it.span);
                }
            }
            AstKind::Function(it) => {
                let parent = nodes.parent_kind(id);
                let is_method = matches!(parent, AstKind::MethodDefinition(_))
                    || matches!(parent, AstKind::ObjectProperty(property) if property.method || property.kind != PropertyKind::Init);
                let span = it.span;
                if is_method {
                    match (it.r#async, it.generator) {
                        (true, true) => add(key::ASYNC_GENERATOR_METHODS, span),
                        (true, false) => add(key::ASYNC_METHODS, span),
                        _ => {}
                    }
                } else if it.r#type == FunctionType::FunctionDeclaration {
                    match (it.r#async, it.generator) {
                        (true, true) => add(key::ASYNC_GENERATOR_DECLARATION, span),
                        (true, false) => add(key::ASYNC_FUNCTION_DECLARATION, span),
                        (false, true) => add(key::GENERATOR_DECLARATION, span),
                        (false, false) => {}
                    }
                    if matches!(parent, AstKind::BlockStatement(_) | AstKind::SwitchCase(_)) {
                        add(key::BLOCK_LEVEL_FUNCTIONS, span);
                    }
                } else if it.r#type == FunctionType::FunctionExpression {
                    match (it.r#async, it.generator) {
                        (true, true) => add(key::ASYNC_GENERATOR_EXPRESSION, span),
                        (true, false) => add(key::ASYNC_FUNCTION_EXPRESSION, span),
                        (false, true) => add(key::GENERATOR_EXPRESSION, span),
                        (false, false) => {}
                    }
                }
            }
            AstKind::FormalParameters(it) => {
                let mut seen_default = false;
                for parameter in &it.items {
                    if parameter.initializer.is_some() {
                        seen_default = true;
                        add(key::DEFAULT_PARAMETERS, parameter.span);
                        if matches!(
                            parameter.pattern,
                            BindingPattern::ObjectPattern(_) | BindingPattern::ArrayPattern(_)
                        ) {
                            add(key::DESTRUCTURED_DEFAULTS, parameter.span);
                        }
                    } else if seen_default {
                        add(key::PARAMETERS_AFTER_DEFAULTS, parameter.span);
                    }
                }
                if let Some(rest) = &it.rest {
                    add(key::REST_PARAMETERS, rest.span);
                    if !matches!(rest.rest.argument, BindingPattern::BindingIdentifier(_)) {
                        add(key::REST_DESTRUCTURING, rest.span);
                    }
                }
                let last_end = it
                    .rest
                    .as_ref()
                    .map(|rest| rest.span.end)
                    .or_else(|| it.items.last().map(|item| item.span.end));
                if last_end.is_some_and(|end| trailing_comma(source, end)) {
                    add(key::TRAILING_COMMAS, it.span);
                }
            }
            AstKind::AwaitExpression(it) => add(key::AWAIT, it.span),
            AstKind::YieldExpression(it) => add(if it.delegate { key::YIELD_STAR } else { key::YIELD }, it.span),
            AstKind::Class(it) => {
                add(
                    if it.r#type == ClassType::ClassDeclaration {
                        key::CLASS_DECLARATION
                    } else {
                        key::CLASS_EXPRESSION
                    },
                    it.span,
                );
                if it.heritage.is_some() {
                    add(key::EXTENDS, it.span);
                }
            }
            AstKind::MethodDefinition(it) => {
                // Abstract methods and overload signatures have no body and produce no code.
                if it.r#type == MethodDefinitionType::TSAbstractMethodDefinition || it.value.body.is_none() {
                    continue;
                }
                match it.kind {
                    MethodDefinitionKind::Constructor => add(key::CONSTRUCTOR, it.span),
                    MethodDefinitionKind::Method => add(key::METHOD_DEFINITIONS, it.span),
                    MethodDefinitionKind::Get if it.computed => add(key::GET_COMPUTED, it.span),
                    MethodDefinitionKind::Set if it.computed => add(key::SET_COMPUTED, it.span),
                    _ => {}
                }
                if it.r#static {
                    add(key::STATIC_MEMBERS, it.span);
                }
                if matches!(it.key, PropertyKey::PrivateIdentifier(_)) {
                    add(key::PRIVATE_METHODS, it.span);
                }
            }
            AstKind::PropertyDefinition(it) => {
                if it.r#type == PropertyDefinitionType::TSAbstractPropertyDefinition || it.declare {
                    continue;
                }
                if matches!(it.key, PropertyKey::PrivateIdentifier(_)) {
                    add(key::PRIVATE_FIELDS, it.span);
                } else if it.r#static {
                    add(key::STATIC_FIELDS, it.span);
                } else {
                    add(key::PUBLIC_FIELDS, it.span);
                }
            }
            AstKind::PrivateInExpression(it) => add(key::PRIVATE_IN, it.span),
            AstKind::StaticBlock(it) => add(key::STATIC_BLOCKS, it.span),
            AstKind::Super(it) => add(key::SUPER, it.span),
            AstKind::NewTarget(it) => add(key::NEW_TARGET, it.span),
            AstKind::ChainExpression(it) => add(key::OPTIONAL_CHAINING, it.span),
            AstKind::LogicalExpression(it) => {
                if it.operator == LogicalOperator::Coalesce {
                    add(key::NULLISH, it.span);
                }
            }
            AstKind::AssignmentExpression(it) => match it.operator {
                AssignmentOperator::LogicalAnd => add(key::LOGICAL_AND_ASSIGNMENT, it.span),
                AssignmentOperator::LogicalOr => add(key::LOGICAL_OR_ASSIGNMENT, it.span),
                AssignmentOperator::LogicalNullish => add(key::NULLISH_ASSIGNMENT, it.span),
                AssignmentOperator::Exponential => add(key::EXPONENTIATION_ASSIGNMENT, it.span),
                _ => {}
            },
            AstKind::BinaryExpression(it) => {
                if it.operator == BinaryOperator::Exponential {
                    add(key::EXPONENTIATION, it.span);
                }
            }
            AstKind::UpdateExpression(it) => add(
                if it.operator == UpdateOperator::Increment {
                    key::INCREMENT
                } else {
                    key::DECREMENT
                },
                it.span,
            ),
            AstKind::VariableDeclaration(it) => match it.kind {
                VariableDeclarationKind::Let => add(key::LET, it.span),
                VariableDeclarationKind::Const => add(key::CONST, it.span),
                VariableDeclarationKind::Using => add(key::USING, it.span),
                VariableDeclarationKind::AwaitUsing => add(key::AWAIT_USING, it.span),
                VariableDeclarationKind::Var => {}
            },
            AstKind::ForOfStatement(it) => add(if it.r#await { key::FOR_AWAIT_OF } else { key::FOR_OF }, it.span),
            AstKind::CatchClause(it) => {
                if it.param.is_none() {
                    add(key::OPTIONAL_CATCH_BINDING, it.span);
                }
            }
            AstKind::DebuggerStatement(it) => add(key::DEBUGGER, it.span),
            AstKind::EmptyStatement(it) => add(key::EMPTY, it.span),
            AstKind::ObjectPattern(it) => {
                add(key::DESTRUCTURING, it.span);
                if it.rest.is_some() {
                    add(key::REST_IN_OBJECTS, it.span);
                }
            }
            AstKind::ArrayPattern(it) => {
                add(key::DESTRUCTURING, it.span);
                if it.rest.is_some() {
                    add(key::REST_IN_ARRAYS, it.span);
                }
            }
            AstKind::ObjectAssignmentTarget(it) => {
                add(key::DESTRUCTURING, it.span);
                if it.rest.is_some() {
                    add(key::REST_IN_OBJECTS, it.span);
                }
            }
            AstKind::ArrayAssignmentTarget(it) => {
                add(key::DESTRUCTURING, it.span);
                if it.rest.is_some() {
                    add(key::REST_IN_ARRAYS, it.span);
                }
            }
            AstKind::BindingProperty(it) if it.computed => add(key::DESTRUCTURING_COMPUTED, it.span),
            AstKind::AssignmentTargetPropertyProperty(it) if it.computed => {
                add(key::DESTRUCTURING_COMPUTED, it.span);
            }
            _ => {}
        }
    }
    uses
}

/// `10n` is syntax too: a browser without `BigInt` does not parse the file, so its origin is `Parse`.
fn push(uses: &mut Vec<Use<'_>>, targets: &Targets, feature: FeatureId, kind: Kind, span: Span, node: NodeId) {
    if !targets.is_supported(feature) {
        uses.push(Use::new(feature, kind, Origin::Parse, span, node));
    }
}

fn numeric(add: &mut impl FnMut(FeatureId, Span), raw: &str, binary: bool, octal: bool, span: Span) {
    if binary {
        add(key::BINARY_LITERALS, span);
    }
    // `017` is a legacy octal literal with base Octal too; only `0o17` is the ES2015 syntax.
    if octal && raw.len() > 1 && raw.as_bytes()[1].eq_ignore_ascii_case(&b'o') {
        add(key::OCTAL_LITERALS, span);
    }
    if raw.contains('_') {
        add(key::NUMERIC_SEPARATORS, span);
    }
}

/// Marks the nodes that are ambient or lie inside an ambient node, indexed by node id.
/// One pass in id order is enough: oxc numbers nodes as it creates them, parents first.
/// A walk over the ancestors of every node costs O(depth²) on a long chain like `a + b + …`.
pub(crate) fn ambient_nodes(nodes: &AstNodes<'_>) -> Vec<bool> {
    let mut ambient = vec![false; nodes.len()];
    for node in nodes.iter() {
        let id = node.id();
        // The root is its own parent.
        let parent = nodes.parent_id(id);
        debug_assert!(parent.index() < id.index() || id == NodeId::ROOT);
        ambient[id.index()] = is_ambient(node.kind()) || ambient[parent.index()];
    }
    ambient
}

/// TypeScript declarations produce no JavaScript, so their syntax never reaches a browser.
fn is_ambient(kind: AstKind<'_>) -> bool {
    // The count is here, not in `ambient_nodes`: a walk over ancestors calls this once per ancestor.
    count!(ambient);
    match kind {
        AstKind::Class(class) => class.declare,
        AstKind::Function(function) => {
            function.declare || function.body.is_none() || function.r#type == FunctionType::TSDeclareFunction
        }
        AstKind::TSNamespaceDeclaration(module) => module.declare,
        // Quoted module names are legal only in ambient modules.
        AstKind::TSExternalModuleDeclaration(_) | AstKind::TSGlobalDeclaration(_) => true,
        // Type-level syntax: it is erased and never reaches a browser.
        AstKind::TSTypeAnnotation(_)
        | AstKind::TSTypeAliasDeclaration(_)
        | AstKind::TSInterfaceDeclaration(_)
        | AstKind::TSFunctionType(_)
        | AstKind::TSMethodSignature(_)
        | AstKind::TSCallSignatureDeclaration(_)
        | AstKind::TSConstructSignatureDeclaration(_)
        | AstKind::TSConstructorType(_) => true,
        AstKind::VariableDeclaration(declaration) => declaration.declare,
        _ => false,
    }
}

/// True when `u{` follows an odd number of backslashes: `\u{1F600}` is an escape, `\\u{` is not.
pub(super) fn has_code_point_escape(raw: &str) -> bool {
    raw.match_indices("u{")
        .any(|(index, _)| raw[..index].bytes().rev().take_while(|&byte| byte == b'\\').count() % 2 == 1)
}

/// The AST does not keep trailing commas. The next character that is not whitespace or a comment tells.
fn trailing_comma(source: &str, offset: u32) -> bool {
    let mut rest = &source[offset as usize..];
    loop {
        rest = rest.trim_start();
        if let Some(after) = rest.strip_prefix("//") {
            rest = after.split_once('\n').map_or("", |(_, tail)| tail);
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.split_once("*/").map_or("", |(_, tail)| tail);
        } else {
            return rest.starts_with(',');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::check::with_semantic;
    use crate::data::feature_ids;

    fn detected(source: &str, filename: &str) -> Vec<FeatureId> {
        with_semantic(source, filename, |semantic, _| {
            detect(
                semantic,
                &ambient_nodes(semantic.nodes()),
                &Targets::missing_everything(),
            )
            .into_iter()
            .map(|usage| usage.feature)
            .collect()
        })
        .unwrap()
    }

    const SAMPLES: &[(FeatureId, &str)] = &[
        (key::BINARY_LITERALS, "0b101;"),
        (key::NUMERIC_SEPARATORS, "1_000;"),
        (key::OCTAL_LITERALS, "0o17;"),
        (key::TEMPLATE_LITERALS, "`a`;"),
        (key::TEMPLATE_REVISION, "tag`\\unicode`;"),
        (key::TRAILING_COMMAS, "function f(a,) {}"),
        (key::UNICODE_POINT_ESCAPES, "'\\u{1F600}';"),
        (key::ASYNC_FUNCTION_EXPRESSION, "(async function () {});"),
        (key::ASYNC_GENERATOR_EXPRESSION, "(async function* () {});"),
        (key::AWAIT, "async function f() { await 1; }"),
        (key::CLASS_EXPRESSION, "(class {});"),
        (key::DECREMENT, "let a = 1; a--;"),
        (key::INCREMENT, "let a = 1; a++;"),
        (key::DESTRUCTURING, "const [a] = [1];"),
        (key::DESTRUCTURING_COMPUTED, "const { [k]: v } = o;"),
        (key::REST_IN_ARRAYS, "const [...r] = a;"),
        (key::REST_IN_OBJECTS, "const { ...r } = o;"),
        (key::EXPONENTIATION, "2 ** 3;"),
        (key::EXPONENTIATION_ASSIGNMENT, "let a = 2; a **= 3;"),
        (key::GENERATOR_EXPRESSION, "(function* () {});"),
        (key::LOGICAL_AND_ASSIGNMENT, "let a; a &&= 1;"),
        (key::LOGICAL_OR_ASSIGNMENT, "let a; a ||= 1;"),
        (key::NEW_TARGET, "function F() { return new.target; }"),
        (key::NULLISH, "a ?? b;"),
        (key::NULLISH_ASSIGNMENT, "let a; a ??= 1;"),
        (key::COMPUTED_PROPERTIES, "({ [k]: 1 });"),
        (key::SHORTHAND_METHODS, "({ m() {} });"),
        (key::SHORTHAND_PROPERTIES, "({ a });"),
        (key::OPTIONAL_CHAINING, "a?.b;"),
        (key::SPREAD_IN_ARRAYS, "[...a];"),
        (key::SPREAD_IN_CALLS, "f(...a);"),
        (key::SPREAD_IN_OBJECTS, "({ ...o });"),
        (key::SUPER, "class A extends B { m() { super.m(); } }"),
        (key::YIELD, "function* g() { yield 1; }"),
        (key::YIELD_STAR, "function* g() { yield* h(); }"),
        (key::ASYNC_FUNCTION_DECLARATION, "async function f() {}"),
        (key::ASYNC_GENERATOR_DECLARATION, "async function* f() {}"),
        (key::AWAIT_USING, "async function f() { await using r = g(); }"),
        (key::CLASS_DECLARATION, "class A {}"),
        (key::CONST, "const a = 1;"),
        (key::DEBUGGER, "debugger;"),
        (key::EMPTY, ";"),
        (key::FOR_AWAIT_OF, "async function f() { for await (const x of y) {} }"),
        (key::FOR_OF, "for (const x of y) {}"),
        (key::GENERATOR_DECLARATION, "function* g() {}"),
        (key::LET, "let a = 1;"),
        (key::OPTIONAL_CATCH_BINDING, "try {} catch {}"),
        (key::USING, "{ using r = g(); }"),
        (key::CONSTRUCTOR, "class A { constructor() {} }"),
        (key::EXTENDS, "class A extends B {}"),
        (key::PRIVATE_FIELDS, "class A { #x = 1; }"),
        (key::PRIVATE_IN, "class A { #x; static has(o) { return #x in o; } }"),
        (key::PRIVATE_METHODS, "class A { #m() {} }"),
        (key::PUBLIC_FIELDS, "class A { x = 1; }"),
        (key::STATIC_MEMBERS, "class A { static m() {} }"),
        (key::STATIC_FIELDS, "class A { static x = 1; }"),
        (key::STATIC_BLOCKS, "class A { static {} }"),
        (key::ARROW_FUNCTIONS, "(() => 1);"),
        (key::BLOCK_LEVEL_FUNCTIONS, "{ function f() {} }"),
        (key::DEFAULT_PARAMETERS, "function f(a = 1) {}"),
        (key::DESTRUCTURED_DEFAULTS, "function f({ a } = {}) {}"),
        (key::PARAMETERS_AFTER_DEFAULTS, "function f(a = 1, b) {}"),
        (key::GET_COMPUTED, "({ get [k]() { return 1; } });"),
        (key::SET_COMPUTED, "({ set [k](v) {} });"),
        (key::METHOD_DEFINITIONS, "({ m() {} });"),
        (key::ASYNC_GENERATOR_METHODS, "({ async *m() {} });"),
        (key::ASYNC_METHODS, "({ async m() {} });"),
        (key::REST_PARAMETERS, "function f(...a) {}"),
        (key::REST_DESTRUCTURING, "function f(...[a]) {}"),
        (key::BIGINT, "10n;"),
    ];

    #[test]
    fn every_emitted_key_has_a_sample_that_triggers_it() {
        for key in EMITTED {
            let (_, source) = SAMPLES
                .iter()
                .find(|(sample, _)| sample == key)
                .unwrap_or_else(|| panic!("{} has no sample", key.as_str()));
            assert!(
                detected(source, "a.js").contains(key),
                "{} not detected in {source}",
                key.as_str()
            );
        }
    }

    #[test]
    fn supported_syntax_is_no_use() {
        with_semantic("const a = 1; a ?? 2; class A { #x = 1; }", "a.js", |semantic, _| {
            let targets = Targets::resolve("Chrome >= 97").unwrap();
            assert!(detect(semantic, &ambient_nodes(semantic.nodes()), &targets).is_empty());
            let targets = Targets::resolve("Chrome >= 70").unwrap();
            let found: Vec<_> = detect(semantic, &ambient_nodes(semantic.nodes()), &targets)
                .into_iter()
                .map(|usage| usage.feature)
                .collect();
            assert_eq!(found, [key::NULLISH, key::PRIVATE_FIELDS]);
        })
        .unwrap();
    }

    #[test]
    fn a_bigint_literal_is_a_parse_error_without_bigint() {
        with_semantic("10n;", "a.js", |semantic, _| {
            let uses = detect(
                semantic,
                &ambient_nodes(semantic.nodes()),
                &Targets::missing_everything(),
            );
            let bigint = uses.iter().find(|usage| usage.feature == key::BIGINT).unwrap();
            assert_eq!(bigint.origin, Origin::Parse);
            assert_eq!(bigint.kind, Kind::Builtin);
        })
        .unwrap();
    }

    #[test]
    fn a_hashbang_is_not_tracked() {
        let hashbang = "javascript.grammar.hashbang_comments";
        assert!(untracked_reason(hashbang).is_some());
        let found = detected("#!/usr/bin/env node\n1;", "a.js");
        assert!(found.iter().all(|feature| feature.as_str() != hashbang), "{found:?}");
    }

    #[test]
    fn modern_code_without_new_syntax_reports_nothing() {
        assert!(detected("var a = 1; function f(b) { return b + a; } f(a);", "a.js").is_empty());
    }

    #[test]
    fn trailing_comma_check_skips_comments() {
        assert!(!detected("f(a /* , */);", "a.js").contains(&key::TRAILING_COMMAS));
        assert!(detected("f(a, // note\n);", "a.js").contains(&key::TRAILING_COMMAS));
    }

    #[test]
    fn typescript_declarations_without_code_are_not_syntax_uses() {
        let found = detected(
            "declare class A { static x: number; #y: string; }\n\
             abstract class B { abstract m(): void; declare z: number; }\n\
             declare function f(a?: number,): void;\n",
            "a.ts",
        );
        assert_eq!(found, [key::CLASS_DECLARATION]);
    }

    #[test]
    fn ambient_and_type_only_code_is_not_a_syntax_use() {
        let nothing: [FeatureId; 0] = [];
        for (source, file) in [
            (
                "declare module 'x' { const c: string; class K { static s: number } }",
                "a.ts",
            ),
            ("declare namespace N { let x: number }", "a.ts"),
            ("declare global { const g: number }", "a.ts"),
            ("declare const d: number;", "a.ts"),
            ("export class A { static x: number } export const c: number;", "a.d.ts"),
            ("type F = (...a: any[]) => void;", "a.ts"),
            ("interface I { m(\n a: string,\n): void }", "a.ts"),
        ] {
            assert_eq!(detected(source, file), nothing, "{source}");
        }
        assert_eq!(
            detected("abstract class C { abstract m(...a: any[]): void }", "a.ts"),
            [key::CLASS_DECLARATION]
        );
        let overloads = detected("class D { m(a: string): void; m(a) {} }", "a.ts");
        assert_eq!(
            overloads.iter().filter(|key| **key == key::METHOD_DEFINITIONS).count(),
            1
        );
        assert!(overloads.contains(&key::CLASS_DECLARATION));
    }

    #[test]
    fn escaped_backslash_is_not_a_code_point_escape() {
        assert!(!detected("'\\\\u{1F600}';", "a.js").contains(&key::UNICODE_POINT_ESCAPES));
        assert!(!detected("`\\\\u{1F600}`;", "a.js").contains(&key::UNICODE_POINT_ESCAPES));
        assert!(detected("'\\u{1F600}';", "a.js").contains(&key::UNICODE_POINT_ESCAPES));
    }

    #[test]
    fn assignment_patterns_and_methods_map_to_their_own_keys() {
        assert!(detected("let a, b; [a, b] = [b, a];", "a.js").contains(&key::DESTRUCTURING));
        let rest = detected("let r; ({ ...r } = o);", "a.js");
        assert!(
            rest.contains(&key::DESTRUCTURING) && rest.contains(&key::REST_IN_OBJECTS),
            "{rest:?}"
        );
        assert!(!detected("017;", "a.js").contains(&key::OCTAL_LITERALS));
        let method = detected("class A { async m() {} }", "a.js");
        assert!(method.contains(&key::ASYNC_METHODS), "{method:?}");
        assert!(!method.contains(&key::ASYNC_FUNCTION_EXPRESSION), "{method:?}");
        assert!(!detected("f(x => x, y);", "a.js").contains(&key::TRAILING_COMMAS));
    }

    // The ambient check used to walk all ancestors of every node, so a deep expression cost
    // O(depth²): a chain of 20 000 terms is 20 000 levels deep. Generated files in node_modules
    // have such chains. Member reads add nodes per level. The test counts the nodes that the check
    // visits at two sizes; a quadratic walk breaks the bound already at the smaller one.
    #[test]
    fn a_deep_expression_is_checked_in_linear_time() {
        // `a.b.c.d.e + ` is ten nodes.
        const STEPS_PER_TERM: usize = 16;
        for terms in [1000, 4000] {
            let source = format!("x = {};", vec!["a.b.c.d.e"; terms].join(" + "));
            // oxc builds and visits the AST recursively; a debug build needs more than the 2 MiB
            // stack of a test thread for this depth. The counters belong to the thread.
            let steps = std::thread::Builder::new()
                .stack_size(64 << 20)
                .spawn(move || {
                    with_semantic(&source, "a.js", |semantic, _| {
                        crate::counters::take();
                        detect(
                            semantic,
                            &ambient_nodes(semantic.nodes()),
                            &Targets::missing_everything(),
                        );
                        crate::counters::take()
                    })
                    .unwrap()
                })
                .unwrap()
                .join()
                .unwrap();
            assert!(steps.ambient <= STEPS_PER_TERM * terms, "{terms} terms: {steps:?}");
        }
    }

    #[test]
    fn every_bcd_syntax_key_has_a_decision() {
        // Regular expression keys belong to the regex detector and have their own test there.
        const GROUPS: [&str; 5] = [
            "javascript.grammar.",
            "javascript.operators.",
            "javascript.statements.",
            "javascript.classes",
            "javascript.functions",
        ];
        let missing: Vec<&str> = feature_ids()
            .filter(|key| GROUPS.iter().any(|group| key.starts_with(group)))
            .filter(|key| {
                !EMITTED.iter().any(|emitted| emitted.as_str() == *key)
                    && !ALIASES.iter().any(|(alias, _)| alias == key)
                    && untracked_reason(key).is_none()
                    && !ancient(key)
            })
            .collect();
        assert!(missing.is_empty(), "BCD syntax keys without a decision: {missing:#?}");
    }
}

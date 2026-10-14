//! Syntax that needs a newer browser: `??=`, class fields, `#x in obj` and the like.
//! BCD names syntax in words, so a hand-written table maps AST nodes to BCD keys.
//! The completeness test makes sure that every BCD syntax key has a decision.

use oxc_ast::AstKind;
use oxc_ast::ast::{
    AssignmentOperator, BigintBase, BinaryOperator, BindingPattern, ChainElement, ChainExpression, ClassType,
    Decorator, Expression, Function, FunctionType, LogicalOperator, MethodDefinitionKind, MethodDefinitionType,
    NumberBase, PropertyDefinitionType, PropertyKey, PropertyKind, UpdateOperator, VariableDeclarationKind,
};
use oxc_semantic::{AstNodes, NodeId, Semantic};
use oxc_span::{GetSpan, Span};

use super::slot::{SpreadInto, spread_into};
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
/// The range of a use is the token of the feature, not the whole node: `docs/syntax-ranges.md` of the
/// core package lists the token of each key.
pub fn detect<'a>(semantic: &Semantic<'a>, ambient: &[bool], targets: &Targets) -> Vec<Use<'a>> {
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
            // The raw text of a string literal starts at its span, quote included.
            AstKind::StringLiteral(it) => {
                if let Some(escape) = it
                    .raw
                    .as_ref()
                    .and_then(|raw| code_point_escape(raw.as_str(), it.span.start))
                {
                    add(key::UNICODE_POINT_ESCAPES, escape);
                }
            }
            // The span of a template element is its raw text, without the backticks and `${`.
            AstKind::TemplateElement(it) => {
                if let Some(escape) = code_point_escape(it.value.raw.as_str(), it.span.start) {
                    add(key::UNICODE_POINT_ESCAPES, escape);
                }
            }
            AstKind::TemplateLiteral(it) => add(key::TEMPLATE_LITERALS, prefix(source, it.span, "`")),
            AstKind::TaggedTemplateExpression(it) => {
                if let Some(quasi) = it.quasi.quasis.iter().find(|quasi| quasi.value.cooked.is_none()) {
                    add(key::TEMPLATE_REVISION, quasi.span);
                }
            }
            AstKind::ObjectProperty(it) => {
                let key = || member_key(source, it.span.start, &it.key, it.computed);
                match it.kind {
                    PropertyKind::Init => {
                        if it.shorthand {
                            add(key::SHORTHAND_PROPERTIES, it.key.span());
                        }
                        if it.method {
                            add(key::SHORTHAND_METHODS, key());
                            add(key::METHOD_DEFINITIONS, key());
                        }
                        if it.computed {
                            add(key::COMPUTED_PROPERTIES, key());
                        }
                    }
                    PropertyKind::Get if it.computed => add(key::GET_COMPUTED, key()),
                    PropertyKind::Set if it.computed => add(key::SET_COMPUTED, key()),
                    _ => {}
                }
            }
            AstKind::SpreadElement(it) => {
                let span = prefix(source, it.span, "...");
                match spread_into(nodes, id) {
                    Some(SpreadInto::Array) => add(key::SPREAD_IN_ARRAYS, span),
                    Some(SpreadInto::Object) => add(key::SPREAD_IN_OBJECTS, span),
                    Some(SpreadInto::Call) => add(key::SPREAD_IN_CALLS, span),
                    None => {}
                }
            }
            AstKind::CallExpression(it) => {
                if let Some(comma) = it
                    .arguments
                    .last()
                    .and_then(|last| trailing_comma(source, last.span().end))
                {
                    add(key::TRAILING_COMMAS, comma);
                }
            }
            AstKind::NewExpression(it) => {
                if let Some(comma) = it
                    .arguments
                    .last()
                    .and_then(|last| trailing_comma(source, last.span().end))
                {
                    add(key::TRAILING_COMMAS, comma);
                }
            }
            AstKind::ArrowFunctionExpression(it) => {
                let parameters_end = it
                    .return_type
                    .as_ref()
                    .map_or(it.params.span.end, |types| types.span.end);
                add(
                    key::ARROW_FUNCTIONS,
                    token_at(source, parameters_end, "=>").unwrap_or(it.span),
                );
                if it.r#async {
                    add(key::ASYNC_FUNCTION_EXPRESSION, prefix(source, it.span, "async"));
                }
            }
            AstKind::Function(it) => {
                let parent = nodes.parent_kind(id);
                // The span of a method value starts at its parameters; the modifiers belong to the member.
                let member = match parent {
                    AstKind::MethodDefinition(method) => {
                        Some((after_decorators(method.span, &method.decorators), method.key.span()))
                    }
                    AstKind::ObjectProperty(property) if property.method || property.kind != PropertyKind::Init => {
                        Some((property.span.start, property.key.span()))
                    }
                    _ => None,
                };
                if let Some((start, key)) = member {
                    if it.r#async {
                        let span = async_head(source, start, key.start, it.generator).unwrap_or(it.span);
                        add(
                            if it.generator {
                                key::ASYNC_GENERATOR_METHODS
                            } else {
                                key::ASYNC_METHODS
                            },
                            span,
                        );
                    }
                    continue;
                }
                let span = function_head(source, it).unwrap_or(it.span);
                if it.r#type == FunctionType::FunctionDeclaration {
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
                        let pattern_end = parameter
                            .type_annotation
                            .as_ref()
                            .map_or(parameter.pattern.span().end, |types| types.span.end);
                        let equals = token_at(source, pattern_end, "=").unwrap_or(parameter.span);
                        add(key::DEFAULT_PARAMETERS, equals);
                        if matches!(
                            parameter.pattern,
                            BindingPattern::ObjectPattern(_) | BindingPattern::ArrayPattern(_)
                        ) {
                            add(key::DESTRUCTURED_DEFAULTS, equals);
                        }
                    } else if seen_default {
                        add(key::PARAMETERS_AFTER_DEFAULTS, first_token(source, &parameter.pattern));
                    }
                }
                if let Some(rest) = &it.rest {
                    let dots = prefix(source, rest.rest.span, "...");
                    add(key::REST_PARAMETERS, dots);
                    if !matches!(rest.rest.argument, BindingPattern::BindingIdentifier(_)) {
                        add(key::REST_DESTRUCTURING, dots);
                    }
                }
                let last_end = it
                    .rest
                    .as_ref()
                    .map(|rest| rest.span.end)
                    .or_else(|| it.items.last().map(|item| item.span.end));
                if let Some(comma) = last_end.and_then(|end| trailing_comma(source, end)) {
                    add(key::TRAILING_COMMAS, comma);
                }
            }
            AstKind::AwaitExpression(it) => add(key::AWAIT, prefix(source, it.span, "await")),
            AstKind::YieldExpression(it) => {
                if it.delegate {
                    let star =
                        token_at(source, it.span.start, "yield").and_then(|keyword| token_at(source, keyword.end, "*"));
                    add(
                        key::YIELD_STAR,
                        star.map_or(it.span, |star| Span::new(it.span.start, star.end)),
                    );
                } else {
                    add(key::YIELD, prefix(source, it.span, "yield"));
                }
            }
            AstKind::Class(it) => {
                let class_keyword = keyword(
                    source,
                    after_decorators(it.span, &it.decorators),
                    it.body.span.start,
                    "class",
                );
                add(
                    if it.r#type == ClassType::ClassDeclaration {
                        key::CLASS_DECLARATION
                    } else {
                        key::CLASS_EXPRESSION
                    },
                    class_keyword.unwrap_or(it.span),
                );
                if let Some(heritage) = &it.heritage {
                    // `extends` follows the name and the type parameters, which may hold `extends` too.
                    let start = it
                        .type_parameters
                        .as_ref()
                        .map(|parameters| parameters.span.end)
                        .or_else(|| it.id.as_ref().map(|name| name.span.end))
                        .or_else(|| class_keyword.map(|keyword| keyword.end));
                    let extends = start.and_then(|start| token_at(source, start, "extends"));
                    add(key::EXTENDS, extends.unwrap_or(heritage.expression.span()));
                }
            }
            AstKind::MethodDefinition(it) => {
                // Abstract methods and overload signatures have no body and produce no code.
                if it.r#type == MethodDefinitionType::TSAbstractMethodDefinition || it.value.body.is_none() {
                    continue;
                }
                let start = after_decorators(it.span, &it.decorators);
                let key = || member_key(source, start, &it.key, it.computed);
                match it.kind {
                    MethodDefinitionKind::Constructor => add(key::CONSTRUCTOR, key()),
                    MethodDefinitionKind::Method => add(key::METHOD_DEFINITIONS, key()),
                    MethodDefinitionKind::Get if it.computed => add(key::GET_COMPUTED, key()),
                    MethodDefinitionKind::Set if it.computed => add(key::SET_COMPUTED, key()),
                    _ => {}
                }
                if it.r#static {
                    add(
                        key::STATIC_MEMBERS,
                        keyword(source, start, it.key.span().start, "static").unwrap_or(it.span),
                    );
                }
                if matches!(it.key, PropertyKey::PrivateIdentifier(_)) {
                    add(key::PRIVATE_METHODS, it.key.span());
                }
            }
            AstKind::PropertyDefinition(it) => {
                if it.r#type == PropertyDefinitionType::TSAbstractPropertyDefinition || it.declare {
                    continue;
                }
                let start = after_decorators(it.span, &it.decorators);
                if matches!(it.key, PropertyKey::PrivateIdentifier(_)) {
                    add(key::PRIVATE_FIELDS, it.key.span());
                } else if it.r#static {
                    add(
                        key::STATIC_FIELDS,
                        keyword(source, start, it.key.span().start, "static").unwrap_or(it.span),
                    );
                } else {
                    add(key::PUBLIC_FIELDS, member_key(source, start, &it.key, it.computed));
                }
            }
            AstKind::PrivateInExpression(it) => {
                let span = token_at(source, it.left.span.end, "in")
                    .map_or(it.span, |keyword| Span::new(it.left.span.start, keyword.end));
                add(key::PRIVATE_IN, span);
            }
            AstKind::StaticBlock(it) => add(key::STATIC_BLOCKS, prefix(source, it.span, "static")),
            AstKind::Super(it) => add(key::SUPER, it.span),
            AstKind::NewTarget(it) => add(key::NEW_TARGET, it.span),
            AstKind::ChainExpression(it) => {
                add(key::OPTIONAL_CHAINING, optional_chain(source, it).unwrap_or(it.span));
            }
            AstKind::LogicalExpression(it) => {
                if it.operator == LogicalOperator::Coalesce {
                    add(
                        key::NULLISH,
                        operator_after(source, it.left.span(), "??").unwrap_or(it.span),
                    );
                }
            }
            AstKind::AssignmentExpression(it) => {
                let feature = match it.operator {
                    AssignmentOperator::LogicalAnd => key::LOGICAL_AND_ASSIGNMENT,
                    AssignmentOperator::LogicalOr => key::LOGICAL_OR_ASSIGNMENT,
                    AssignmentOperator::LogicalNullish => key::NULLISH_ASSIGNMENT,
                    AssignmentOperator::Exponential => key::EXPONENTIATION_ASSIGNMENT,
                    _ => continue,
                };
                let operator = operator_after(source, it.left.span(), it.operator.as_str());
                add(feature, operator.unwrap_or(it.span));
            }
            AstKind::BinaryExpression(it) => {
                if it.operator == BinaryOperator::Exponential {
                    add(
                        key::EXPONENTIATION,
                        operator_after(source, it.left.span(), "**").unwrap_or(it.span),
                    );
                }
            }
            AstKind::UpdateExpression(it) => {
                // The operator is the first or the last two characters of the node.
                let operator = match it.prefix {
                    true => Span::sized(it.span.start, 2),
                    false => Span::new(it.span.end.saturating_sub(2), it.span.end),
                };
                let text = source.get(operator.start as usize..operator.end as usize);
                let operator = match text {
                    Some("++" | "--") => operator,
                    _ => it.span,
                };
                add(
                    if it.operator == UpdateOperator::Increment {
                        key::INCREMENT
                    } else {
                        key::DECREMENT
                    },
                    operator,
                );
            }
            AstKind::VariableDeclaration(it) => match it.kind {
                VariableDeclarationKind::Let => add(key::LET, prefix(source, it.span, "let")),
                VariableDeclarationKind::Const => add(key::CONST, prefix(source, it.span, "const")),
                VariableDeclarationKind::Using => add(key::USING, prefix(source, it.span, "using")),
                VariableDeclarationKind::AwaitUsing => {
                    let using = token_at(source, it.span.start, "await")
                        .and_then(|keyword| token_at(source, keyword.end, "using"));
                    add(
                        key::AWAIT_USING,
                        using.map_or(it.span, |using| Span::new(it.span.start, using.end)),
                    );
                }
                VariableDeclarationKind::Var => {}
            },
            AstKind::ForOfStatement(it) => {
                if it.r#await {
                    let wait = token_at(source, it.span.start, "for")
                        .and_then(|keyword| token_at(source, keyword.end, "await"));
                    add(
                        key::FOR_AWAIT_OF,
                        wait.map_or(it.span, |wait| Span::new(it.span.start, wait.end)),
                    );
                } else {
                    add(
                        key::FOR_OF,
                        operator_after(source, it.left.span(), "of").unwrap_or(it.span),
                    );
                }
            }
            AstKind::CatchClause(it) => {
                if it.param.is_none() {
                    add(key::OPTIONAL_CATCH_BINDING, prefix(source, it.span, "catch"));
                }
            }
            AstKind::DebuggerStatement(it) => add(key::DEBUGGER, prefix(source, it.span, "debugger")),
            AstKind::EmptyStatement(it) => add(key::EMPTY, it.span),
            AstKind::ObjectPattern(it) => {
                add(key::DESTRUCTURING, prefix(source, it.span, "{"));
                if let Some(rest) = &it.rest {
                    add(key::REST_IN_OBJECTS, prefix(source, rest.span, "..."));
                }
            }
            AstKind::ArrayPattern(it) => {
                add(key::DESTRUCTURING, prefix(source, it.span, "["));
                if let Some(rest) = &it.rest {
                    add(key::REST_IN_ARRAYS, prefix(source, rest.span, "..."));
                }
            }
            AstKind::ObjectAssignmentTarget(it) => {
                add(key::DESTRUCTURING, prefix(source, it.span, "{"));
                if let Some(rest) = &it.rest {
                    add(key::REST_IN_OBJECTS, prefix(source, rest.span, "..."));
                }
            }
            AstKind::ArrayAssignmentTarget(it) => {
                add(key::DESTRUCTURING, prefix(source, it.span, "["));
                if let Some(rest) = &it.rest {
                    add(key::REST_IN_ARRAYS, prefix(source, rest.span, "..."));
                }
            }
            AstKind::BindingProperty(it) if it.computed => {
                add(
                    key::DESTRUCTURING_COMPUTED,
                    computed_key(source, it.span.start, it.key.span()),
                );
            }
            AstKind::AssignmentTargetPropertyProperty(it) if it.computed => {
                add(
                    key::DESTRUCTURING_COMPUTED,
                    computed_key(source, it.span.start, it.name.span()),
                );
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

/// The first `\u{…}` escape of raw text that starts at the offset `start`. An escape is `u{` after an odd
/// number of backslashes: `\u{1F600}` is an escape, `\\u{` is not.
pub(super) fn code_point_escape(raw: &str, start: u32) -> Option<Span> {
    let (index, _) = raw
        .match_indices("u{")
        .find(|(index, _)| raw[..*index].bytes().rev().take_while(|&byte| byte == b'\\').count() % 2 == 1)?;
    let end = raw[index..].find('}').map_or(raw.len(), |close| index + close + 1);
    // The escape starts at its backslash, one byte before `u`.
    Some(Span::new(start + index as u32 - 1, start + end as u32))
}

/// The trailing comma after the last item that ends at `offset`, if any. The AST does not keep trailing
/// commas.
fn trailing_comma(source: &str, offset: u32) -> Option<Span> {
    token_at(source, offset, ",")
}

// oxc keeps the spans of nodes, not of keywords and operators. The helpers below find the token of a
// feature in the source from the boundaries of nodes. A helper gives `None` when the token is not where
// the grammar puts it; the caller then reports the whole node. Every token they look for is ASCII, so a
// range never splits a character.

/// The offset of the next token at or after `offset`: whitespace and comments skipped.
fn next_token(source: &str, offset: u32) -> u32 {
    let mut rest = &source[offset as usize..];
    loop {
        // U+FEFF is whitespace in JavaScript, but not in Rust.
        rest = rest.trim_start_matches(|char: char| char.is_whitespace() || char == '\u{FEFF}');
        if let Some(after) = rest.strip_prefix("//") {
            let end = after.find(['\n', '\r', '\u{2028}', '\u{2029}']).unwrap_or(after.len());
            rest = &after[end..];
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.split_once("*/").map_or("", |(_, tail)| tail);
        } else {
            return (source.len() - rest.len()) as u32;
        }
    }
}

/// `token` when it is the next token at or after `offset`.
fn token_at(source: &str, offset: u32, token: &str) -> Option<Span> {
    let start = next_token(source, offset);
    source[start as usize..]
        .starts_with(token)
        .then(|| Span::sized(start, token.len() as u32))
}

/// The operator after the left operand. oxc leaves the parentheses around an assignment target out of
/// its span, `(a) ??= b`, so the closing parentheses are skipped too.
fn operator_after(source: &str, left: Span, operator: &str) -> Option<Span> {
    let mut start = next_token(source, left.end);
    while source.as_bytes().get(start as usize) == Some(&b')') {
        start = next_token(source, start + 1);
    }
    source[start as usize..]
        .starts_with(operator)
        .then(|| Span::sized(start, operator.len() as u32))
}

/// The first characters of a node that always starts with `token`, such as `static {` or `...rest`. The
/// whole node if it does not.
fn prefix(source: &str, span: Span, token: &str) -> Span {
    match source[span.start as usize..].starts_with(token) {
        true => Span::sized(span.start, token.len() as u32),
        false => span,
    }
}

/// The word `word` among the tokens from `start` to `end`: a modifier before the key of a member, or
/// `class` after `abstract`. A modifier never hides in a string, so the scan needs words and comments only.
fn keyword(source: &str, start: u32, end: u32, word: &str) -> Option<Span> {
    let mut offset = start;
    loop {
        offset = next_token(source, offset);
        if offset >= end {
            return None;
        }
        let rest = &source[offset as usize..end as usize];
        let length = rest
            .find(|char: char| !(char.is_alphanumeric() || char == '_' || char == '$'))
            .unwrap_or(rest.len());
        if length == 0 {
            // `*`, `[`, `#` or another punctuator.
            offset += rest.chars().next().map_or(1, char::len_utf8) as u32;
        } else if &rest[..length] == word {
            return Some(Span::sized(offset, length as u32));
        } else {
            offset += length as u32;
        }
    }
}

/// The start of a class or a member after its decorators: they hold any tokens, `@d([1])`.
fn after_decorators(span: Span, decorators: &[Decorator<'_>]) -> u32 {
    decorators.last().map_or(span.start, |decorator| decorator.span.end)
}

/// The key of a member that starts at `start`, with the brackets of a computed key.
fn member_key(source: &str, start: u32, key: &PropertyKey<'_>, computed: bool) -> Span {
    match computed {
        true => computed_key(source, start, key.span()),
        false => key.span(),
    }
}

/// `[k]`: the brackets of a computed key are no part of the key node. The open bracket is the last
/// `[` token between the start of the member and the key; modifiers such as `static async *` come first.
fn computed_key(source: &str, start: u32, key: Span) -> Span {
    let mut open = None;
    let mut offset = start;
    loop {
        offset = next_token(source, offset);
        if offset >= key.start {
            break;
        }
        let char = source[offset as usize..].chars().next().unwrap_or(' ');
        if char == '[' {
            open = Some(offset);
        }
        offset += char.len_utf8() as u32;
    }
    match (open, token_at(source, key.end, "]")) {
        (Some(open), Some(close)) => Span::new(open, close.end),
        _ => key,
    }
}

/// `async` or `async *` before the key of a method.
fn async_head(source: &str, start: u32, key: u32, generator: bool) -> Option<Span> {
    let keyword = keyword(source, start, key, "async")?;
    let end = match generator {
        true => token_at(source, keyword.end, "*")?.end,
        false => keyword.end,
    };
    Some(Span::new(keyword.start, end))
}

/// The keywords of a function before its name or its parameters: `function`, `async function*`.
fn function_head(source: &str, function: &Function<'_>) -> Option<Span> {
    let end = function
        .id
        .as_ref()
        .map_or(function.params.span.start, |name| name.span.start);
    let keyword = keyword(source, function.span.start, end, "function")?;
    let end = match function.generator {
        true => token_at(source, keyword.end, "*")?.end,
        false => keyword.end,
    };
    Some(Span::new(function.span.start, end))
}

/// The first token of a binding: the name, or the bracket that opens a pattern.
fn first_token(source: &str, pattern: &BindingPattern<'_>) -> Span {
    match pattern {
        BindingPattern::ObjectPattern(it) => prefix(source, it.span, "{"),
        BindingPattern::ArrayPattern(it) => prefix(source, it.span, "["),
        _ => pattern.span(),
    }
}

/// The first `?.` of a chain, in the order of the source: the one nearest to the start of the chain.
/// The walk goes from the end of the chain to its start and keeps the last optional link it passes.
fn optional_chain(source: &str, chain: &ChainExpression<'_>) -> Option<Span> {
    // The end of the expression before the `?.` found last.
    let mut before = None;
    let mut expression = match &chain.expression {
        ChainElement::CallExpression(call) => {
            if call.optional {
                before = Some(call.callee.span().end);
            }
            &call.callee
        }
        ChainElement::TSNonNullExpression(it) => &it.expression,
        element => {
            let member = element.as_member_expression()?;
            if member.optional() {
                before = Some(member.object().span().end);
            }
            member.object()
        }
    };
    loop {
        expression = match expression {
            Expression::CallExpression(call) => {
                if call.optional {
                    before = Some(call.callee.span().end);
                }
                &call.callee
            }
            Expression::TSNonNullExpression(it) => &it.expression,
            // Parentheses end the chain: `(a?.b).c` holds a chain of its own.
            _ => match expression.as_member_expression() {
                Some(member) => {
                    if member.optional() {
                        before = Some(member.object().span().end);
                    }
                    member.object()
                }
                None => break,
            },
        };
    }
    token_at(source, before?, "?.")
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

    /// A sample of each key and the text of its range: the token of the feature, not the whole node.
    const SAMPLES: &[(FeatureId, &str, &str)] = &[
        (key::BINARY_LITERALS, "0b101;", "0b101"),
        (key::NUMERIC_SEPARATORS, "1_000;", "1_000"),
        (key::OCTAL_LITERALS, "0o17;", "0o17"),
        (key::TEMPLATE_LITERALS, "`a`;", "`"),
        (key::TEMPLATE_REVISION, "tag`\\unicode`;", "\\unicode"),
        (key::TRAILING_COMMAS, "function f(a,) {}", ","),
        (key::UNICODE_POINT_ESCAPES, "'\\u{1F600}';", "\\u{1F600}"),
        (
            key::ASYNC_FUNCTION_EXPRESSION,
            "(async function () {});",
            "async function",
        ),
        (
            key::ASYNC_GENERATOR_EXPRESSION,
            "(async function* () {});",
            "async function*",
        ),
        (key::AWAIT, "async function f() { await 1; }", "await"),
        (key::CLASS_EXPRESSION, "(class {});", "class"),
        (key::DECREMENT, "let a = 1; a--;", "--"),
        (key::INCREMENT, "let a = 1; a++;", "++"),
        (key::DESTRUCTURING, "const [a] = [1];", "["),
        (key::DESTRUCTURING_COMPUTED, "const { [k]: v } = o;", "[k]"),
        (key::REST_IN_ARRAYS, "const [...r] = a;", "..."),
        (key::REST_IN_OBJECTS, "const { ...r } = o;", "..."),
        (key::EXPONENTIATION, "2 ** 3;", "**"),
        (key::EXPONENTIATION_ASSIGNMENT, "let a = 2; a **= 3;", "**="),
        (key::GENERATOR_EXPRESSION, "(function* () {});", "function*"),
        (key::LOGICAL_AND_ASSIGNMENT, "let a; a &&= 1;", "&&="),
        (key::LOGICAL_OR_ASSIGNMENT, "let a; a ||= 1;", "||="),
        (key::NEW_TARGET, "function F() { return new.target; }", "new.target"),
        (key::NULLISH, "a ?? b;", "??"),
        (key::NULLISH_ASSIGNMENT, "let a; a ??= 1;", "??="),
        (key::COMPUTED_PROPERTIES, "({ [k]: 1 });", "[k]"),
        (key::SHORTHAND_METHODS, "({ m() {} });", "m"),
        (key::SHORTHAND_PROPERTIES, "({ a });", "a"),
        (key::OPTIONAL_CHAINING, "a?.b;", "?."),
        (key::SPREAD_IN_ARRAYS, "[...a];", "..."),
        (key::SPREAD_IN_CALLS, "f(...a);", "..."),
        (key::SPREAD_IN_OBJECTS, "({ ...o });", "..."),
        (key::SUPER, "class A extends B { m() { super.m(); } }", "super"),
        (key::YIELD, "function* g() { yield 1; }", "yield"),
        (key::YIELD_STAR, "function* g() { yield* h(); }", "yield*"),
        (
            key::ASYNC_FUNCTION_DECLARATION,
            "async function f() {}",
            "async function",
        ),
        (
            key::ASYNC_GENERATOR_DECLARATION,
            "async function* f() {}",
            "async function*",
        ),
        (
            key::AWAIT_USING,
            "async function f() { await using r = g(); }",
            "await using",
        ),
        (key::CLASS_DECLARATION, "class A {}", "class"),
        (key::CONST, "const a = 1;", "const"),
        (key::DEBUGGER, "debugger;", "debugger"),
        (key::EMPTY, ";", ";"),
        (
            key::FOR_AWAIT_OF,
            "async function f() { for await (const x of y) {} }",
            "for await",
        ),
        (key::FOR_OF, "for (const x of y) {}", "of"),
        (key::GENERATOR_DECLARATION, "function* g() {}", "function*"),
        (key::LET, "let a = 1;", "let"),
        (key::OPTIONAL_CATCH_BINDING, "try {} catch {}", "catch"),
        (key::USING, "{ using r = g(); }", "using"),
        (key::CONSTRUCTOR, "class A { constructor() {} }", "constructor"),
        (key::EXTENDS, "class A extends B {}", "extends"),
        (key::PRIVATE_FIELDS, "class A { #x = 1; }", "#x"),
        (
            key::PRIVATE_IN,
            "class A { #x; static has(o) { return #x in o; } }",
            "#x in",
        ),
        (key::PRIVATE_METHODS, "class A { #m() {} }", "#m"),
        (key::PUBLIC_FIELDS, "class A { x = 1; }", "x"),
        (key::STATIC_MEMBERS, "class A { static m() {} }", "static"),
        (key::STATIC_FIELDS, "class A { static x = 1; }", "static"),
        (key::STATIC_BLOCKS, "class A { static {} }", "static"),
        (key::ARROW_FUNCTIONS, "(() => 1);", "=>"),
        (key::BLOCK_LEVEL_FUNCTIONS, "{ function f() {} }", "function"),
        (key::DEFAULT_PARAMETERS, "function f(a = 1) {}", "="),
        (key::DESTRUCTURED_DEFAULTS, "function f({ a } = {}) {}", "="),
        (key::PARAMETERS_AFTER_DEFAULTS, "function f(a = 1, b) {}", "b"),
        (key::GET_COMPUTED, "({ get [k]() { return 1; } });", "[k]"),
        (key::SET_COMPUTED, "({ set [k](v) {} });", "[k]"),
        (key::METHOD_DEFINITIONS, "({ m() {} });", "m"),
        (key::ASYNC_GENERATOR_METHODS, "({ async *m() {} });", "async *"),
        (key::ASYNC_METHODS, "({ async m() {} });", "async"),
        (key::REST_PARAMETERS, "function f(...a) {}", "..."),
        (key::REST_DESTRUCTURING, "function f(...[a]) {}", "..."),
        (key::BIGINT, "10n;", "10n"),
    ];

    #[test]
    fn every_emitted_key_has_a_sample_that_triggers_it() {
        for key in EMITTED {
            let (_, source, _) = SAMPLES
                .iter()
                .find(|(sample, _, _)| sample == key)
                .unwrap_or_else(|| panic!("{} has no sample", key.as_str()));
            assert!(
                detected(source, "a.js").contains(key),
                "{} not detected in {source}",
                key.as_str()
            );
        }
    }

    /// The features of the source with the text of their ranges.
    fn ranges(source: &str, filename: &str) -> Vec<(FeatureId, String)> {
        with_semantic(source, filename, |semantic, _| {
            detect(
                semantic,
                &ambient_nodes(semantic.nodes()),
                &Targets::missing_everything(),
            )
            .into_iter()
            .map(|usage| {
                (
                    usage.feature,
                    source[usage.span.start as usize..usage.span.end as usize].to_string(),
                )
            })
            .collect()
        })
        .unwrap()
    }

    fn range_of(source: &str, filename: &str, feature: FeatureId) -> String {
        let found = ranges(source, filename);
        let mut texts = found.iter().filter(|(key, _)| *key == feature).map(|(_, text)| text);
        let text = texts
            .next()
            .unwrap_or_else(|| panic!("{} not detected in {source}: {found:?}", feature.as_str()));
        assert!(
            texts.next().is_none(),
            "{} detected twice in {source}",
            feature.as_str()
        );
        text.clone()
    }

    #[test]
    fn a_range_covers_the_token_of_the_feature() {
        for (key, source, text) in SAMPLES {
            assert_eq!(range_of(source, "a.js", *key), *text, "{} in {source}", key.as_str());
        }
    }

    #[test]
    fn a_range_skips_decorators_modifiers_comments_and_parentheses() {
        let cases: &[(FeatureId, &str, &str)] = &[
            (key::CLASS_DECLARATION, "@d abstract class A {}", "class"),
            (
                key::EXTENDS,
                "class A<T extends U> /* extends */ extends B {}",
                "extends",
            ),
            (key::EXTENDS, "(class extends B {});", "extends"),
            (key::STATIC_MEMBERS, "class A { @d public static m() {} }", "static"),
            (key::METHOD_DEFINITIONS, "class A { @d public static m() {} }", "m"),
            (key::STATIC_FIELDS, "class A { @d([1]) static x = 1; }", "static"),
            (key::PUBLIC_FIELDS, "class A { @d\n  name = 1; }", "name"),
            (key::PUBLIC_FIELDS, "class A { [ /* ] */ k ] = 1; }", "[ /* ] */ k ]"),
            (
                key::ASYNC_GENERATOR_METHODS,
                "class A { static async /* * */ * [k]() {} }",
                "async /* * */ *",
            ),
            (key::METHOD_DEFINITIONS, "class A { static async *[k]() {} }", "[k]"),
            (key::ASYNC_METHODS, "({ async async() {} });", "async"),
            (key::GET_COMPUTED, "class A { static get [k]() { return 1; } }", "[k]"),
            (key::NULLISH_ASSIGNMENT, "(a) /* ??= */ ??= 1;", "??="),
            (key::NULLISH, "(a as any) ?? b;", "??"),
            (key::EXPONENTIATION, "(-1) ** 2;", "**"),
            (key::INCREMENT, "(a) /* x */ ++;", "++"),
            (key::DECREMENT, "--a;", "--"),
            (key::OPTIONAL_CHAINING, "a.b /* ?. */ ?.c?.d();", "?."),
            (key::OPTIONAL_CHAINING, "f?.();", "?."),
            (key::OPTIONAL_CHAINING, "a!?.[0];", "?."),
            (key::ARROW_FUNCTIONS, "async (z): T => z;", "=>"),
            (key::ASYNC_FUNCTION_EXPRESSION, "async (z): T => z;", "async"),
            (key::ARROW_FUNCTIONS, "x /* => */ => x;", "=>"),
            (key::DEFAULT_PARAMETERS, "function f(a: number = 1) {}", "="),
            (key::DESTRUCTURED_DEFAULTS, "function f({\n  a,\n} = {}) {}", "="),
            (key::PARAMETERS_AFTER_DEFAULTS, "function f(a = 1, {\n  b,\n}) {}", "{"),
            (key::REST_DESTRUCTURING, "function f(...{\n  length,\n}) {}", "..."),
            (key::TRAILING_COMMAS, "f(a, /* , */\n);", ","),
            (key::FOR_OF, "for ((a) of b) {}", "of"),
            (
                key::BLOCK_LEVEL_FUNCTIONS,
                "{ async function* f() {} }",
                "async function*",
            ),
            (
                key::YIELD_STAR,
                "function* g() { yield /* x */ * h(); }",
                "yield /* x */ *",
            ),
            (
                key::PRIVATE_IN,
                "class A { #x; static has(o) { return #x /* c */ in o; } }",
                "#x /* c */ in",
            ),
            (key::TEMPLATE_LITERALS, "`a${\n  b\n}c`;", "`"),
            (key::DESTRUCTURING, "({ a } = o);", "{"),
            // Non-ASCII text before the token and inside the literal: offsets stay on character boundaries.
            (
                key::UNICODE_POINT_ESCAPES,
                "'é \\\\u{1} \\u{1F600} \\u{2}';",
                "\\u{1F600}",
            ),
            (key::UNICODE_POINT_ESCAPES, "`Мяу ${a} \\u{1F600}`;", "\\u{1F600}"),
            (key::NULLISH, "'Мяу' ?? b;", "??"),
        ];
        for (key, source, text) in cases {
            assert_eq!(range_of(source, "a.ts", *key), *text, "{} in {source}", key.as_str());
        }
    }

    #[test]
    fn a_range_in_tsx_is_the_token_of_the_feature() {
        let cases: &[(FeatureId, &str, &str)] = &[
            (key::ARROW_FUNCTIONS, "<T,>(x: T): T => x;", "=>"),
            (key::ARROW_FUNCTIONS, "async <T,>(x: T) => x;", "=>"),
            (key::ASYNC_FUNCTION_EXPRESSION, "async <T,>(x: T) => x;", "async"),
            (key::ARROW_FUNCTIONS, "(x): (() => void) => x;", "=>"),
            (key::NULLISH, "(a as any) ?? <b />;", "??"),
            (
                key::CLASS_DECLARATION,
                "@d\nexport abstract class A<T> extends B<T> {}",
                "class",
            ),
            (
                key::EXTENDS,
                "@d\nexport abstract class A<T> extends B<T> {}",
                "extends",
            ),
        ];
        for (key, source, text) in cases {
            assert_eq!(range_of(source, "a.tsx", *key), *text, "{} in {source}", key.as_str());
        }
    }

    #[test]
    fn a_helper_gives_the_node_when_the_source_does_not_show_the_token() {
        assert_eq!(prefix("static {}", Span::new(0, 9), "static"), Span::new(0, 6));
        assert_eq!(prefix("{ a }", Span::new(0, 5), "["), Span::new(0, 5));
        assert_eq!(token_at("a /* ?? */ b", 1, "??"), None);
        assert_eq!(
            operator_after("(a) ) ??= 1", Span::new(1, 2), "??="),
            Some(Span::new(6, 9))
        );
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

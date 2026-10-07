//! Regular expression syntax and flags: lookbehind, named groups, the `v` flag and the like.
//! Covers literals and `new RegExp('…')` or `RegExp('…')` with string literal arguments.

use oxc_allocator::Allocator;
use oxc_ast::AstKind;
use oxc_ast::ast::{Argument, Expression, RegExpFlags};
use oxc_regular_expression::ast::{
    CapturingGroup, IgnoreGroup, LookAroundAssertion, LookAroundAssertionKind, NamedReference, Pattern,
    UnicodePropertyEscape,
};
use oxc_regular_expression::visit::{Visit, walk};
use oxc_regular_expression::{LiteralParser, Options};
use oxc_semantic::{NodeId, Semantic};
use oxc_span::Span;

use super::Use;
use crate::check::Kind;
use crate::data::FeatureId;

const LOOKBEHIND: &str = "javascript.regular_expressions.lookbehind_assertion";
const MODIFIERS: &str = "javascript.regular_expressions.modifier";
const NAMED_REFERENCE: &str = "javascript.regular_expressions.named_backreference";
const NAMED_GROUP: &str = "javascript.regular_expressions.named_capturing_group";
const DUPLICATE_NAMED_GROUPS: &str =
    "javascript.regular_expressions.named_capturing_group.duplicate_named_capturing_groups";
const PROPERTY_ESCAPE: &str = "javascript.regular_expressions.unicode_character_class_escape";
const CODE_POINT_ESCAPE: &str = "javascript.regular_expressions.character_escape.unicode";
const DOT_ALL: &str = "javascript.builtins.RegExp.dotAll";
const HAS_INDICES: &str = "javascript.builtins.RegExp.hasIndices";
const UNICODE_SETS: &str = "javascript.builtins.RegExp.unicodeSets";
const STICKY: &str = "javascript.builtins.RegExp.sticky";
const UNICODE: &str = "javascript.builtins.RegExp.unicode";

// Read by the completeness test of this detector.
#[allow(dead_code)]
pub const EMITTED: &[&str] = &[
    LOOKBEHIND,
    MODIFIERS,
    NAMED_REFERENCE,
    NAMED_GROUP,
    DUPLICATE_NAMED_GROUPS,
    PROPERTY_ESCAPE,
    CODE_POINT_ESCAPE,
    DOT_ALL,
    HAS_INDICES,
    UNICODE_SETS,
    STICKY,
    UNICODE,
];

#[derive(Clone, Copy, Default)]
struct Flags {
    dot_all: bool,
    has_indices: bool,
    unicode_sets: bool,
    sticky: bool,
    unicode: bool,
}

impl Flags {
    fn from_literal(flags: RegExpFlags) -> Self {
        Self {
            dot_all: flags.contains(RegExpFlags::S),
            has_indices: flags.contains(RegExpFlags::D),
            unicode_sets: flags.contains(RegExpFlags::V),
            sticky: flags.contains(RegExpFlags::Y),
            unicode: flags.contains(RegExpFlags::U),
        }
    }

    fn from_text(flags: &str) -> Self {
        Self {
            dot_all: flags.contains('s'),
            has_indices: flags.contains('d'),
            unicode_sets: flags.contains('v'),
            sticky: flags.contains('y'),
            unicode: flags.contains('u'),
        }
    }
}

pub fn detect<'a>(semantic: &Semantic<'a>, allocator: &'a Allocator) -> Vec<Use> {
    let scoping = semantic.scoping();
    let mut uses = Vec::new();
    for node in semantic.nodes().iter() {
        let (callee, arguments, span) = match node.kind() {
            AstKind::RegExpLiteral(literal) => {
                let flags = Flags::from_literal(literal.regex.flags);
                let pattern = literal.regex.pattern.pattern.as_deref();
                report(
                    &mut uses,
                    pattern,
                    literal.regex.pattern.text.as_str(),
                    flags,
                    literal.span,
                    node.id(),
                );
                continue;
            }
            AstKind::NewExpression(expression) => (&expression.callee, &expression.arguments, expression.span),
            AstKind::CallExpression(call) => (&call.callee, &call.arguments, call.span),
            _ => continue,
        };
        let Expression::Identifier(identifier) = callee.get_inner_expression() else {
            continue;
        };
        // A local `RegExp` is not the builtin.
        let is_global = scoping.get_reference(identifier.reference_id()).symbol_id().is_none();
        if identifier.name.as_str() != "RegExp" || !is_global {
            continue;
        }
        let Some(Argument::StringLiteral(pattern_literal)) = arguments.first() else {
            continue;
        };
        let flags_text = match arguments.get(1) {
            Some(Argument::StringLiteral(flags)) => Some(allocator.alloc_str(flags.value.as_str())),
            Some(_) => continue,
            None => None,
        };
        let pattern_text = allocator.alloc_str(pattern_literal.value.as_str());
        // An invalid pattern throws at run time; that is a bug of the code, not a compatibility finding.
        let Ok(pattern) = LiteralParser::new(allocator, pattern_text, flags_text, Options::default()).parse() else {
            continue;
        };
        let flags = flags_text.map(Flags::from_text).unwrap_or_default();
        let first_new = uses.len();
        report(&mut uses, Some(&pattern), pattern_text, flags, span, node.id());
        // A pattern in a string is parsed at run time, so a `try` can catch it. A literal is parsed with the file.
        for usage in &mut uses[first_new..] {
            usage.catchable = true;
        }
    }
    uses
}

fn report(uses: &mut Vec<Use>, pattern: Option<&Pattern<'_>>, text: &str, flags: Flags, span: Span, node: NodeId) {
    let mut add = |key: &'static str| {
        let feature = FeatureId::find(key);
        debug_assert!(feature.is_some(), "{key} is not in the BCD data");
        if let Some(feature) = feature {
            uses.push(Use::new(feature, Kind::Syntax, span, node));
        }
    };
    let flag_keys = [
        (flags.dot_all, DOT_ALL),
        (flags.has_indices, HAS_INDICES),
        (flags.unicode_sets, UNICODE_SETS),
        (flags.sticky, STICKY),
        (flags.unicode, UNICODE),
    ];
    for (set, key) in flag_keys {
        if set {
            add(key);
        }
    }
    if (flags.unicode || flags.unicode_sets) && text.contains("\\u{") {
        add(CODE_POINT_ESCAPE);
    }
    let Some(pattern) = pattern else {
        return;
    };
    let mut collector = Collector::default();
    collector.visit_pattern(pattern);
    let mut names = collector.group_names.clone();
    names.sort_unstable();
    let duplicates = names.windows(2).any(|pair| pair[0] == pair[1]);
    for (found, key) in [
        (collector.lookbehind, LOOKBEHIND),
        (collector.modifiers, MODIFIERS),
        (collector.named_reference, NAMED_REFERENCE),
        (!collector.group_names.is_empty(), NAMED_GROUP),
        (duplicates, DUPLICATE_NAMED_GROUPS),
        (collector.property_escape, PROPERTY_ESCAPE),
    ] {
        if found {
            add(key);
        }
    }
}

#[derive(Default)]
struct Collector {
    lookbehind: bool,
    modifiers: bool,
    named_reference: bool,
    property_escape: bool,
    group_names: Vec<String>,
}

impl<'a> Visit<'a> for Collector {
    fn visit_lookaround_assertion(&mut self, it: &LookAroundAssertion<'a>) {
        if matches!(
            it.kind,
            LookAroundAssertionKind::Lookbehind | LookAroundAssertionKind::NegativeLookbehind
        ) {
            self.lookbehind = true;
        }
        walk::walk_lookaround_assertion(self, it);
    }

    fn visit_ignore_group(&mut self, it: &IgnoreGroup<'a>) {
        if it.modifiers.is_some() {
            self.modifiers = true;
        }
        walk::walk_ignore_group(self, it);
    }

    fn visit_capturing_group(&mut self, it: &CapturingGroup<'a>) {
        if let Some(name) = &it.name {
            self.group_names.push(name.as_str().to_string());
        }
        walk::walk_capturing_group(self, it);
    }

    fn visit_named_reference(&mut self, _it: &NamedReference<'a>) {
        self.named_reference = true;
    }

    fn visit_unicode_property_escape(&mut self, _it: &UnicodePropertyEscape<'a>) {
        self.property_escape = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::check::with_semantic;

    fn detected(source: &str) -> Vec<&'static str> {
        with_semantic(source, "a.js", |semantic, allocator| {
            detect(semantic, allocator)
                .into_iter()
                .map(|usage| usage.feature.as_str())
                .collect()
        })
        .unwrap()
    }

    const SAMPLES: &[(&str, &str)] = &[
        (LOOKBEHIND, r"/(?<=\$)\d+/;"),
        (MODIFIERS, "/(?i:a)b/;"),
        (NAMED_REFERENCE, r"/(?<x>a)\k<x>/;"),
        (NAMED_GROUP, "/(?<x>a)/;"),
        (DUPLICATE_NAMED_GROUPS, "/(?<x>a)|(?<x>b)/;"),
        (PROPERTY_ESCAPE, r"/\p{L}/u;"),
        (CODE_POINT_ESCAPE, r"/\u{1F600}/u;"),
        (DOT_ALL, "/a.b/s;"),
        (HAS_INDICES, "/a/d;"),
        (UNICODE_SETS, "/[a--b]/v;"),
        (STICKY, "/a/y;"),
        (UNICODE, "/a/u;"),
    ];

    #[test]
    fn every_emitted_key_exists_in_bcd_and_has_a_sample_that_triggers_it() {
        for key in EMITTED {
            assert!(FeatureId::find(key).is_some(), "{key} is not in the BCD data");
            let (_, source) = SAMPLES.iter().find(|(sample, _)| sample == key).unwrap();
            assert!(detected(source).contains(key), "{key} not detected in {source}");
        }
    }

    #[test]
    fn a_plain_regex_reports_nothing() {
        assert!(detected(r"/^a+(b|c)\d$/gi;").is_empty());
    }

    #[test]
    fn checks_the_regexp_constructor_with_literal_arguments() {
        let found = detected(r"new RegExp('(?<=a)b', 'v'); RegExp('(?<n>a)');");
        assert!(
            found.contains(&LOOKBEHIND) && found.contains(&UNICODE_SETS) && found.contains(&NAMED_GROUP),
            "{found:?}"
        );
    }

    #[test]
    fn every_bcd_regex_key_has_a_decision() {
        let missing: Vec<&str> = crate::data::feature_ids()
            .filter(|key| key.starts_with("javascript.regular_expressions."))
            .filter(|key| {
                !EMITTED.contains(key)
                    && super::super::syntax::untracked_reason(key).is_none()
                    && !super::super::syntax::ancient(key)
            })
            .collect();
        assert!(missing.is_empty(), "BCD regex keys without a decision: {missing:#?}");
    }

    #[test]
    fn ignores_a_local_regexp_binding_and_dynamic_or_invalid_patterns() {
        assert!(detected("const RegExp = Foo; new RegExp('(?<=a)');").is_empty());
        assert!(detected("new RegExp(source); new RegExp('('); new RegExp('a', 'qq');").is_empty());
    }
}

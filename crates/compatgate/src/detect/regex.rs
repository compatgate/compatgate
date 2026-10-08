//! Regular expression syntax and flags: lookbehind, named groups, the `v` flag and the like.
//! Covers literals and `new RegExp('…')` or `RegExp('…')` with arguments that are string literals,
//! templates without expressions, or a regex literal with new flags.

use oxc_allocator::Allocator;
use oxc_ast::AstKind;
use oxc_ast::ast::{Argument, Expression, RegExpFlags, RegExpLiteral};
use oxc_regular_expression::ast::{
    CapturingGroup, Character, CharacterKind, IgnoreGroup, LookAroundAssertion, LookAroundAssertionKind,
    NamedReference, Pattern, UnicodePropertyEscape,
};
use oxc_regular_expression::visit::{Visit, walk};
use oxc_regular_expression::{LiteralParser, Options};
use oxc_semantic::{NodeId, Semantic};
use oxc_span::Span;

use super::path::{is_global, path};
use super::syntax::has_code_point_escape;
use super::{Origin, Use};
use crate::check::Kind;
use crate::data::FeatureId;
use crate::targets::Targets;

const LOOKBEHIND: FeatureId = FeatureId::known("javascript.regular_expressions.lookbehind_assertion");
const MODIFIERS: FeatureId = FeatureId::known("javascript.regular_expressions.modifier");
const NAMED_REFERENCE: FeatureId = FeatureId::known("javascript.regular_expressions.named_backreference");
const NAMED_GROUP: FeatureId = FeatureId::known("javascript.regular_expressions.named_capturing_group");
const DUPLICATE_NAMED_GROUPS: FeatureId =
    FeatureId::known("javascript.regular_expressions.named_capturing_group.duplicate_named_capturing_groups");
const PROPERTY_ESCAPE: FeatureId = FeatureId::known("javascript.regular_expressions.unicode_character_class_escape");
const CODE_POINT_ESCAPE: FeatureId = FeatureId::known("javascript.regular_expressions.character_escape.unicode");
const DOT_ALL: FeatureId = FeatureId::known("javascript.builtins.RegExp.dotAll");
const HAS_INDICES: FeatureId = FeatureId::known("javascript.builtins.RegExp.hasIndices");
const UNICODE_SETS: FeatureId = FeatureId::known("javascript.builtins.RegExp.unicodeSets");
const STICKY: FeatureId = FeatureId::known("javascript.builtins.RegExp.sticky");
const UNICODE: FeatureId = FeatureId::known("javascript.builtins.RegExp.unicode");

// Read by the completeness test of this detector.
#[allow(dead_code)]
pub const EMITTED: &[FeatureId] = &[
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

pub fn detect<'a>(semantic: &Semantic<'a>, allocator: &'a Allocator, targets: &Targets) -> Vec<Use<'a>> {
    let mut uses = Vec::new();
    for node in semantic.nodes().iter() {
        let (callee, arguments, span) = match node.kind() {
            AstKind::RegExpLiteral(literal) => {
                report_literal(&mut uses, targets, literal, node.id());
                continue;
            }
            AstKind::NewExpression(expression) => (&expression.callee, &expression.arguments, expression.span),
            AstKind::CallExpression(call) => (&call.callee, &call.arguments, call.span),
            _ => continue,
        };
        let Expression::Identifier(identifier) = callee.get_inner_expression() else {
            continue;
        };
        // Few calls are `RegExp`, so the name check goes before the scope lookup.
        if identifier.name.as_str() != "RegExp" {
            continue;
        }
        // A local `RegExp` is not the builtin.
        if !is_global(semantic, identifier) {
            continue;
        }
        let flags_text = match arguments.get(1) {
            None => None,
            Some(argument) => match literal_text(argument, semantic) {
                Some(text) => Some(text),
                None => continue,
            },
        };
        // Features that the literal argument reports itself. The call must not repeat them.
        let mut known = Vec::new();
        let pattern_text = match arguments.first() {
            // `RegExp(/a/u)` keeps the flags, and the literal reports itself. New flags replace the
            // flags of the literal, so its source is parsed again with them.
            Some(Argument::RegExpLiteral(literal)) if flags_text.is_some() => {
                report_literal(&mut known, targets, literal, node.id());
                literal.regex.pattern.text.as_str()
            }
            Some(argument) => match literal_text(argument, semantic) {
                Some(text) => text,
                None => continue,
            },
            None => continue,
        };
        // An invalid pattern throws at run time; that is a bug of the code, not a compatibility finding.
        let Ok(pattern) = LiteralParser::new(allocator, pattern_text, flags_text, Options::default()).parse() else {
            continue;
        };
        let flags = flags_text.map(Flags::from_text).unwrap_or_default();
        let source = Source {
            text: pattern_text,
            start: 0,
        };
        let mut found = Vec::new();
        report(&mut found, targets, Some(&pattern), source, flags, span, node.id());
        // A pattern in a string is parsed at run time, so a `try` can catch it. A literal is parsed with the file.
        uses.extend(
            found
                .into_iter()
                .filter(|usage| !known.iter().any(|old: &Use<'_>| old.feature == usage.feature))
                .map(|usage| Use {
                    origin: Origin::Call,
                    ..usage
                }),
        );
    }
    uses
}

fn report_literal(uses: &mut Vec<Use<'_>>, targets: &Targets, literal: &RegExpLiteral<'_>, node: NodeId) {
    // oxc parsed the pattern with spans in the file: the pattern starts after the `/`.
    let source = Source {
        text: literal.regex.pattern.text.as_str(),
        start: literal.span.start + 1,
    };
    report(
        uses,
        targets,
        literal.regex.pattern.pattern.as_deref(),
        source,
        Flags::from_literal(literal.regex.flags),
        literal.span,
        node,
    );
}

/// The value of a string literal, of a template without expressions, or of `String.raw` with such a template.
fn literal_text<'a>(argument: &Argument<'a>, semantic: &Semantic<'_>) -> Option<&'a str> {
    // A value with lone surrogates is stored with a substitute escape, not as the program sees it.
    match argument {
        Argument::StringLiteral(literal) if !literal.lone_surrogates => Some(literal.value.as_str()),
        Argument::TemplateLiteral(template) if template.quasis.iter().all(|quasi| !quasi.lone_surrogates) => {
            template.single_quasi().map(|cooked| cooked.as_str())
        }
        // `String.raw` keeps the backslashes as written, so the raw text is the value.
        Argument::TaggedTemplateExpression(tagged) if is_string_raw(&tagged.tag, semantic) => {
            match tagged.quasi.quasis.as_slice() {
                [only] => Some(only.value.raw.as_str()),
                _ => None,
            }
        }
        _ => None,
    }
}

/// `String.raw`, `(String?.raw)`, or `String.raw` through the global object: `globalThis.String.raw`.
/// A local `String` or `window` is not the global.
fn is_string_raw(tag: &Expression<'_>, semantic: &Semantic<'_>) -> bool {
    path(semantic, tag).is_some_and(|path| path == ["String", "raw"])
}

/// The pattern text and its offset: spans of a parsed literal count from the start of the file,
/// spans of a pattern parsed here count from the start of the text.
#[derive(Clone, Copy)]
struct Source<'a> {
    text: &'a str,
    start: u32,
}

fn report<'a>(
    uses: &mut Vec<Use<'_>>,
    targets: &Targets,
    pattern: Option<&Pattern<'a>>,
    source: Source<'a>,
    flags: Flags,
    span: Span,
    node: NodeId,
) {
    let mut add = |feature: FeatureId| {
        if !targets.is_supported(feature) {
            uses.push(Use::new(feature, Kind::Syntax, Origin::Parse, span, node));
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
    let Some(pattern) = pattern else {
        return;
    };
    let mut collector = Collector::new(source);
    collector.visit_pattern(pattern);
    collector.group_names.sort_unstable();
    let duplicates = collector.group_names.windows(2).any(|pair| pair[0] == pair[1]);
    for (found, key) in [
        (collector.lookbehind, LOOKBEHIND),
        (collector.modifiers, MODIFIERS),
        (collector.named_reference, NAMED_REFERENCE),
        (!collector.group_names.is_empty(), NAMED_GROUP),
        (duplicates, DUPLICATE_NAMED_GROUPS),
        (collector.property_escape, PROPERTY_ESCAPE),
        (collector.code_point_escape, CODE_POINT_ESCAPE),
    ] {
        if found {
            add(key);
        }
    }
}

struct Collector<'a> {
    source: Source<'a>,
    lookbehind: bool,
    modifiers: bool,
    named_reference: bool,
    property_escape: bool,
    code_point_escape: bool,
    group_names: Vec<&'a str>,
}

impl<'a> Collector<'a> {
    fn new(source: Source<'a>) -> Self {
        Self {
            source,
            lookbehind: false,
            modifiers: false,
            named_reference: false,
            property_escape: false,
            code_point_escape: false,
            group_names: Vec::new(),
        }
    }

    /// The source text from a parser offset to the end of the pattern. `None` for an offset outside
    /// the text or inside a character: the offset comes from another crate, and a detector must not panic.
    fn source_at(&self, offset: u32) -> Option<&'a str> {
        let offset = offset.checked_sub(self.source.start)?;
        self.source.text.get(offset as usize..)
    }

    /// Whether the name of `(?<name>` or `\k<name>` at the offset has `\u{` in the source. oxc does not
    /// promise whether the AST name is the written or the decoded text, so the source tells.
    fn written_name_has_code_point_escape(&self, offset: u32, prefix: &str) -> bool {
        self.source_at(offset)
            .and_then(|text| text.strip_prefix(prefix))
            .and_then(|text| text.split_once('>'))
            .is_some_and(|(written, _)| has_code_point_escape(written))
    }
}

impl<'a> Visit<'a> for Collector<'a> {
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
            self.group_names.push(name.as_str());
            if self.written_name_has_code_point_escape(it.span.start, "(?<") {
                self.code_point_escape = true;
            }
        }
        walk::walk_capturing_group(self, it);
    }

    fn visit_named_reference(&mut self, it: &NamedReference<'a>) {
        self.named_reference = true;
        if self.written_name_has_code_point_escape(it.span.start, "\\k<") {
            self.code_point_escape = true;
        }
    }

    fn visit_unicode_property_escape(&mut self, _it: &UnicodePropertyEscape<'a>) {
        self.property_escape = true;
    }

    fn visit_character(&mut self, it: &Character) {
        // `\u0041` and `\u{41}` are both unicode escapes; only the braces need a newer browser.
        if it.kind == CharacterKind::UnicodeEscape
            && self
                .source_at(it.span.start)
                .is_some_and(|text| text.starts_with("\\u{"))
        {
            self.code_point_escape = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::check::with_semantic;

    fn detected(source: &str) -> Vec<FeatureId> {
        with_semantic(source, "a.js", |semantic, allocator| {
            detect(semantic, allocator, &Targets::missing_everything())
                .into_iter()
                .map(|usage| usage.feature)
                .collect()
        })
        .unwrap()
    }

    const SAMPLES: &[(FeatureId, &str)] = &[
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
    fn every_emitted_key_has_a_sample_that_triggers_it() {
        for key in EMITTED {
            let (_, source) = SAMPLES.iter().find(|(sample, _)| sample == key).unwrap();
            assert!(
                detected(source).contains(key),
                "{} not detected in {source}",
                key.as_str()
            );
        }
    }

    #[test]
    fn supported_regex_syntax_is_no_use() {
        with_semantic(
            r"/(?<=a)b/u; new RegExp('(?<x>a)', 's');",
            "a.js",
            |semantic, allocator| {
                let targets = Targets::resolve("Chrome >= 97").unwrap();
                assert!(detect(semantic, allocator, &targets).is_empty());
            },
        )
        .unwrap();
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
                !EMITTED.iter().any(|emitted| emitted.as_str() == *key)
                    && super::super::syntax::untracked_reason(key).is_none()
                    && !super::super::syntax::ancient(key)
            })
            .collect();
        assert!(missing.is_empty(), "BCD regex keys without a decision: {missing:#?}");
    }

    #[test]
    fn an_escaped_backslash_before_u_brace_is_not_a_code_point_escape() {
        assert!(!detected(r"/\\u{2}/u;").contains(&CODE_POINT_ESCAPE));
        assert!(detected(r"/\u{2}/u;").contains(&CODE_POINT_ESCAPE));
        assert!(!detected(r"/\u0041/u;").contains(&CODE_POINT_ESCAPE));
        // In a string, `\\u{2}` is the pattern `\u{2}`.
        assert!(detected(r"new RegExp('a\\u{2}', 'u');").contains(&CODE_POINT_ESCAPE));
        assert!(!detected(r"new RegExp('\\\\u{2}', 'u');").contains(&CODE_POINT_ESCAPE));
    }

    #[test]
    fn a_template_without_expressions_is_a_literal_argument() {
        assert!(detected("new RegExp(`(?<=a)`);").contains(&LOOKBEHIND));
        assert!(detected("new RegExp('a', `v`);").contains(&UNICODE_SETS));
        assert!(detected("new RegExp(`(?<=${a})`);").is_empty());
    }

    #[test]
    fn flags_of_the_constructor_replace_the_flags_of_a_literal_argument() {
        assert_eq!(detected("RegExp(/a/, 'v');"), [UNICODE_SETS]);
        // Without new flags the literal reports itself, and the call adds nothing.
        assert_eq!(detected("RegExp(/a/y);"), [STICKY]);
        // Only the literal reports `v`: the call replaces it with no flags.
        assert_eq!(detected("RegExp(/a/v, '');"), [UNICODE_SETS]);
    }

    #[test]
    fn a_literal_argument_with_new_flags_reports_only_what_the_flags_change() {
        // The literal reports the lookbehind; the call does not repeat it.
        assert_eq!(detected("RegExp(/(?<=a)/, 'g');"), [LOOKBEHIND]);
        // Without `u`, the literal `\u{61}` is `u` repeated 61 times; the new flag makes it an escape.
        let mut found = detected(r"RegExp(/\u{61}/, 'u');");
        found.sort_unstable_by_key(|feature| feature.as_str());
        assert_eq!(found, [UNICODE, CODE_POINT_ESCAPE]);
    }

    #[test]
    fn spans_of_a_literal_count_from_the_start_of_the_file() {
        assert!(detected(r"let r = /\u{2}/u;").contains(&CODE_POINT_ESCAPE));
    }

    #[test]
    fn a_code_point_escape_in_a_group_name_is_found() {
        assert!(detected(r"/(?<\u{61}>a)/u;").contains(&CODE_POINT_ESCAPE));
        assert!(detected(r"new RegExp('(?<\\u{61}>a)', 'u');").contains(&CODE_POINT_ESCAPE));
        assert!(!detected("/(?<a>a)/u;").contains(&CODE_POINT_ESCAPE));
    }

    /// Whether the named references of the pattern alone report a code point escape. oxc 0.152 matches
    /// a reference to a group by the written name, so a pattern where only the reference has `\u{` does
    /// not parse, and the group reports the escape too. The visit of the references alone tells them apart.
    fn reference_has_code_point_escape(text: &str) -> bool {
        struct References<'a>(Collector<'a>);
        impl<'a> Visit<'a> for References<'a> {
            fn visit_named_reference(&mut self, it: &NamedReference<'a>) {
                self.0.visit_named_reference(it);
            }
        }
        let allocator = Allocator::default();
        let pattern = LiteralParser::new(&allocator, text, Some("u"), Options::default())
            .parse()
            .unwrap();
        let mut references = References(Collector::new(Source { text, start: 0 }));
        references.visit_pattern(&pattern);
        assert!(references.0.named_reference, "{text}");
        references.0.code_point_escape
    }

    #[test]
    fn a_code_point_escape_in_a_named_reference_is_found() {
        assert!(reference_has_code_point_escape(r"(?<\u{61}>x)\k<\u{61}>"));
        assert!(reference_has_code_point_escape(r"(?<a\u{62}>x)\k<a\u{62}>"));
        assert!(!reference_has_code_point_escape(r"(?<a>x)\k<a>"));
        assert!(!reference_has_code_point_escape(r"(?<\u0061>x)\k<\u0061>"));
        assert!(detected(r"/(?<\u{61}>x)\k<\u{61}>/u;").contains(&CODE_POINT_ESCAPE));
        assert!(detected(r"new RegExp('(?<\\u{61}>x)\\k<\\u{61}>', 'u');").contains(&CODE_POINT_ESCAPE));
        assert!(!detected(r"/(?<a>x)\k<a>/u;").contains(&CODE_POINT_ESCAPE));
    }

    #[test]
    fn string_raw_through_an_optional_chain_or_the_global_object_is_a_literal_argument() {
        let sources = [
            r"new RegExp((String?.raw)`(?<=a)\d`);",
            r"new RegExp(globalThis.String.raw`(?<=a)\d`);",
            r"new RegExp(window.String.raw`(?<=a)\d`);",
            r"new RegExp(self.String.raw`(?<=a)\d`);",
            r"new RegExp((window?.String.raw)`(?<=a)\d`);",
        ];
        for source in sources {
            assert!(detected(source).contains(&LOOKBEHIND), "{source}");
        }
        let ignored = [
            "const globalThis = g; new RegExp(globalThis.String.raw`(?<=a)`);",
            "const String = S; new RegExp((String?.raw)`(?<=a)`);",
            "new RegExp(foo.String.raw`(?<=a)`);",
            "new RegExp(window.String.cooked`(?<=a)`);",
            "new RegExp(window.Strings.raw`(?<=a)`);",
        ];
        for source in ignored {
            assert!(detected(source).is_empty(), "{source}");
        }
    }

    #[test]
    fn string_raw_is_a_literal_argument() {
        assert!(detected(r"new RegExp(String.raw`(?<=a)\d`);").contains(&LOOKBEHIND));
        assert!(detected(r"RegExp(String.raw`(?<=a)\d`, String.raw`v`);").contains(&UNICODE_SETS));
        assert!(detected("const String = S; new RegExp(String.raw`(?<=a)`);").is_empty());
        assert!(detected("new RegExp(String.raw`(?<=${a})`);").is_empty());
        assert!(detected("new RegExp(tag`(?<=a)`);").is_empty());
    }

    #[test]
    fn invalid_flags_report_nothing() {
        assert!(detected("new RegExp('a', 'uv'); new RegExp('a', 'uu');").is_empty());
    }

    #[test]
    fn a_constructor_use_points_at_the_call() {
        with_semantic("new RegExp('(?<=a)');", "a.js", |semantic, allocator| {
            let uses = detect(semantic, allocator, &Targets::missing_everything());
            assert_eq!(uses.len(), 1);
            assert_eq!(uses[0].origin, Origin::Call);
            assert!(matches!(semantic.nodes().kind(uses[0].node), AstKind::NewExpression(_)));
        })
        .unwrap();
    }

    #[test]
    fn ignores_a_local_regexp_binding_and_dynamic_or_invalid_patterns() {
        assert!(detected("const RegExp = Foo; new RegExp('(?<=a)');").is_empty());
        assert!(detected("new RegExp(source); new RegExp('('); new RegExp('a', 'qq');").is_empty());
    }
}

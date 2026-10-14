//! Regular expression syntax and flags: lookbehind, named groups, the `v` flag and the like.
//! Covers literals and `new RegExp('…')` or `RegExp('…')` with arguments that are string literals,
//! templates without expressions, or a regex literal with new flags.

use std::collections::HashSet;

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
use oxc_span::{GetSpan, Span};

use super::path::{is_global, path};
use super::syntax::code_point_escape;
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
    let source = semantic.source_text();
    let mut uses = Vec::new();
    for node in semantic.nodes().iter() {
        let (callee, arguments, span) = match node.kind() {
            AstKind::RegExpLiteral(literal) => {
                report_literal(&mut uses, targets, literal, source, node.id());
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
        let flags_argument = arguments.get(1);
        let flags_text = match flags_argument {
            None => None,
            Some(argument) => match literal_text(argument, semantic) {
                Some(text) => Some(text),
                None => continue,
            },
        };
        // Features that the literal argument reports itself. The call must not repeat them.
        let mut known = Vec::new();
        let Some(pattern_argument) = arguments.first() else {
            continue;
        };
        let (pattern_text, pattern_start) = match pattern_argument {
            // `RegExp(/a/u)` keeps the flags, and the literal reports itself. New flags replace the
            // flags of the literal, so its source is parsed again with them.
            Argument::RegExpLiteral(literal) if flags_text.is_some() => {
                report_literal(&mut known, targets, literal, source, node.id());
                (literal.regex.pattern.text.as_str(), Some(literal.span.start + 1))
            }
            argument => match literal_text(argument, semantic) {
                Some(text) => (text, written_at(argument, text, source)),
                None => continue,
            },
        };
        // An invalid pattern throws at run time; that is a bug of the code, not a compatibility finding.
        let Ok(pattern) = LiteralParser::new(allocator, pattern_text, flags_text, Options::default()).parse() else {
            continue;
        };
        let flags = WrittenFlags {
            flags: flags_text.map(Flags::from_text).unwrap_or_default(),
            text: flags_text.unwrap_or_default(),
            place: match (flags_argument, flags_text) {
                (Some(argument), Some(text)) => Place {
                    node: argument.span(),
                    start: written_at(argument, text, source),
                },
                _ => Place {
                    node: span,
                    start: None,
                },
            },
        };
        let pattern_source = Source {
            text: pattern_text,
            start: 0,
        };
        let pattern_place = Place {
            node: pattern_argument.span(),
            start: pattern_start,
        };
        let mut found = Vec::new();
        report(
            &mut found,
            targets,
            Some(&pattern),
            pattern_source,
            pattern_place,
            flags,
            node.id(),
        );
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

fn report_literal(uses: &mut Vec<Use<'_>>, targets: &Targets, literal: &RegExpLiteral<'_>, source: &str, node: NodeId) {
    // oxc parsed the pattern with spans in the file: the pattern starts after the `/`.
    let pattern = Source {
        text: literal.regex.pattern.text.as_str(),
        start: literal.span.start + 1,
    };
    let place = Place {
        node: literal.span,
        start: Some(0),
    };
    // The flags end the literal, one letter each.
    let flags_start = literal.span.end - literal.regex.flags.bits().count_ones();
    let flags = WrittenFlags {
        flags: Flags::from_literal(literal.regex.flags),
        text: source
            .get(flags_start as usize..literal.span.end as usize)
            .unwrap_or_default(),
        place: Place {
            node: literal.span,
            start: Some(flags_start),
        },
    };
    report(
        uses,
        targets,
        literal.regex.pattern.pattern.as_deref(),
        pattern,
        place,
        flags,
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

/// Where a range of the parsed text lies in the file. `start` is the file offset of the parser offset 0
/// when the file holds the text as written; otherwise the range of a feature is the whole `node`: a string
/// with escapes, such as `'\\d'`, has another text than its value.
#[derive(Clone, Copy)]
struct Place {
    node: Span,
    start: Option<u32>,
}

impl Place {
    fn range(self, span: Span) -> Span {
        match self.start {
            Some(start) => Span::new(start + span.start, start + span.end),
            None => self.node,
        }
    }
}

/// The flags, their text as the parser read it, and where the text is.
#[derive(Clone, Copy)]
struct WrittenFlags<'a> {
    flags: Flags,
    text: &'a str,
    place: Place,
}

/// The file offset of the value of a literal argument when the file holds the value as written: a string
/// or a template without escapes, or `String.raw`, whose value is its raw text.
fn written_at(argument: &Argument<'_>, value: &str, source: &str) -> Option<u32> {
    let (start, end) = match argument {
        Argument::StringLiteral(it) => (it.span.start + 1, it.span.end - 1),
        Argument::TemplateLiteral(it) => {
            let quasi = it.quasis.first()?;
            (quasi.span.start, quasi.span.end)
        }
        Argument::TaggedTemplateExpression(it) => {
            let quasi = it.quasi.quasis.first()?;
            (quasi.span.start, quasi.span.end)
        }
        _ => return None,
    };
    // Both ends must match: the value of `'\\\\'` is `\\`, the first two characters of its text.
    (end as usize == start as usize + value.len() && source.get(start as usize..end as usize) == Some(value))
        .then_some(start)
}

fn report<'a>(
    uses: &mut Vec<Use<'_>>,
    targets: &Targets,
    pattern: Option<&Pattern<'a>>,
    source: Source<'a>,
    place: Place,
    written: WrittenFlags<'_>,
    node: NodeId,
) {
    let flags = written.flags;
    let mut add = |feature: FeatureId, span: Span| {
        if !targets.is_supported(feature) {
            uses.push(Use::new(feature, Kind::Syntax, Origin::Parse, span, node));
        }
    };
    let flag_keys = [
        (flags.dot_all, DOT_ALL, 's'),
        (flags.has_indices, HAS_INDICES, 'd'),
        (flags.unicode_sets, UNICODE_SETS, 'v'),
        (flags.sticky, STICKY, 'y'),
        (flags.unicode, UNICODE, 'u'),
    ];
    for (set, key, letter) in flag_keys {
        if set {
            let span = written.text.find(letter).map_or(written.place.node, |index| {
                written.place.range(Span::sized(index as u32, 1))
            });
            add(key, span);
        }
    }
    let Some(pattern) = pattern else {
        return;
    };
    let mut collector = Collector::new(source);
    collector.visit_pattern(pattern);
    for (found, key) in [
        (collector.lookbehind, LOOKBEHIND),
        (collector.modifiers, MODIFIERS),
        (collector.named_reference, NAMED_REFERENCE),
        (collector.named_group, NAMED_GROUP),
        (collector.duplicate_group, DUPLICATE_NAMED_GROUPS),
        (collector.property_escape, PROPERTY_ESCAPE),
        (collector.code_point_escape, CODE_POINT_ESCAPE),
    ] {
        if let Some(span) = found {
            add(key, place.range(span));
        }
    }
}

/// The first token of each feature in the pattern, in the offsets of the parser.
struct Collector<'a> {
    source: Source<'a>,
    lookbehind: Option<Span>,
    modifiers: Option<Span>,
    named_reference: Option<Span>,
    named_group: Option<Span>,
    duplicate_group: Option<Span>,
    property_escape: Option<Span>,
    code_point_escape: Option<Span>,
    group_names: HashSet<&'a str>,
}

/// Keeps the first range: the visit goes in the order of the source.
fn first(slot: &mut Option<Span>, span: Span) {
    slot.get_or_insert(span);
}

impl<'a> Collector<'a> {
    fn new(source: Source<'a>) -> Self {
        Self {
            source,
            lookbehind: None,
            modifiers: None,
            named_reference: None,
            named_group: None,
            duplicate_group: None,
            property_escape: None,
            code_point_escape: None,
            group_names: HashSet::new(),
        }
    }

    /// The source text from a parser offset to the end of the pattern. `None` for an offset outside
    /// the text or inside a character: the offset comes from another crate, and a detector must not panic.
    fn source_at(&self, offset: u32) -> Option<&'a str> {
        let offset = offset.checked_sub(self.source.start)?;
        self.source.text.get(offset as usize..)
    }

    /// The start of a group up to and including `last`: `(?<name>` or `(?i-m:`. The whole group when the
    /// source does not show it.
    fn head(&self, span: Span, last: char) -> Span {
        self.source_at(span.start)
            .and_then(|text| text.get(..(span.end - span.start) as usize)?.find(last))
            .map_or(span, |index| Span::sized(span.start, index as u32 + 1))
    }

    /// The first `\u{…}` in the name of `(?<name>` or `\k<name>` at the offset. oxc does not promise whether
    /// the AST name is the written or the decoded text, so the source tells.
    fn written_name_code_point_escape(&self, offset: u32, prefix: &str) -> Option<Span> {
        let text = self.source_at(offset)?.strip_prefix(prefix)?;
        let (written, _) = text.split_once('>')?;
        code_point_escape(written, offset + prefix.len() as u32)
    }
}

impl<'a> Visit<'a> for Collector<'a> {
    fn visit_lookaround_assertion(&mut self, it: &LookAroundAssertion<'a>) {
        if matches!(
            it.kind,
            LookAroundAssertionKind::Lookbehind | LookAroundAssertionKind::NegativeLookbehind
        ) {
            // `(?<=` or `(?<!`.
            let span = match self
                .source_at(it.span.start)
                .is_some_and(|text| text.starts_with("(?<"))
            {
                true => Span::sized(it.span.start, 4),
                false => it.span,
            };
            first(&mut self.lookbehind, span);
        }
        walk::walk_lookaround_assertion(self, it);
    }

    fn visit_ignore_group(&mut self, it: &IgnoreGroup<'a>) {
        if it.modifiers.is_some() {
            let head = self.head(it.span, ':');
            first(&mut self.modifiers, head);
        }
        walk::walk_ignore_group(self, it);
    }

    fn visit_capturing_group(&mut self, it: &CapturingGroup<'a>) {
        if let Some(name) = &it.name {
            let head = self.head(it.span, '>');
            first(&mut self.named_group, head);
            if !self.group_names.insert(name.as_str()) {
                first(&mut self.duplicate_group, head);
            }
            if let Some(escape) = self.written_name_code_point_escape(it.span.start, "(?<") {
                first(&mut self.code_point_escape, escape);
            }
        }
        walk::walk_capturing_group(self, it);
    }

    fn visit_named_reference(&mut self, it: &NamedReference<'a>) {
        first(&mut self.named_reference, it.span);
        if let Some(escape) = self.written_name_code_point_escape(it.span.start, "\\k<") {
            first(&mut self.code_point_escape, escape);
        }
    }

    fn visit_unicode_property_escape(&mut self, it: &UnicodePropertyEscape<'a>) {
        first(&mut self.property_escape, it.span);
    }

    fn visit_character(&mut self, it: &Character) {
        // `\u0041` and `\u{41}` are both unicode escapes; only the braces need a newer browser.
        if it.kind == CharacterKind::UnicodeEscape
            && self
                .source_at(it.span.start)
                .is_some_and(|text| text.starts_with("\\u{"))
        {
            first(&mut self.code_point_escape, it.span);
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

    /// A sample of each key and the text of its range: the token of the feature, not the whole literal.
    const SAMPLES: &[(FeatureId, &str, &str)] = &[
        (LOOKBEHIND, r"/(?<=\$)\d+/;", "(?<="),
        (MODIFIERS, "/(?i:a)b/;", "(?i:"),
        (NAMED_REFERENCE, r"/(?<x>a)\k<x>/;", r"\k<x>"),
        (NAMED_GROUP, "/(?<x>a)/;", "(?<x>"),
        (DUPLICATE_NAMED_GROUPS, "/(?<x>a)|(?<x>b)/;", "(?<x>"),
        (PROPERTY_ESCAPE, r"/\p{L}/u;", r"\p{L}"),
        (CODE_POINT_ESCAPE, r"/\u{1F600}/u;", r"\u{1F600}"),
        (DOT_ALL, "/a.b/s;", "s"),
        (HAS_INDICES, "/a/d;", "d"),
        (UNICODE_SETS, "/[a--b]/v;", "v"),
        (STICKY, "/a/y;", "y"),
        (UNICODE, "/a/u;", "u"),
    ];

    #[test]
    fn every_emitted_key_has_a_sample_that_triggers_it() {
        for key in EMITTED {
            let (_, source, _) = SAMPLES.iter().find(|(sample, _, _)| sample == key).unwrap();
            assert!(
                detected(source).contains(key),
                "{} not detected in {source}",
                key.as_str()
            );
        }
    }

    /// The features of the source with the text and the start of their ranges.
    fn ranges(source: &str) -> Vec<(FeatureId, String, u32)> {
        with_semantic(source, "a.js", |semantic, allocator| {
            detect(semantic, allocator, &Targets::missing_everything())
                .into_iter()
                .map(|usage| {
                    let text = source[usage.span.start as usize..usage.span.end as usize].to_string();
                    (usage.feature, text, usage.span.start)
                })
                .collect()
        })
        .unwrap()
    }

    fn range_of(source: &str, feature: FeatureId) -> (String, u32) {
        let found = ranges(source);
        let mut matching = found.iter().filter(|(key, _, _)| *key == feature);
        let (_, text, start) = matching
            .next()
            .unwrap_or_else(|| panic!("{} not detected in {source}: {found:?}", feature.as_str()));
        assert!(
            matching.next().is_none(),
            "{} detected twice in {source}",
            feature.as_str()
        );
        (text.clone(), *start)
    }

    #[test]
    fn a_range_covers_the_token_of_the_feature() {
        for (key, source, text) in SAMPLES {
            assert_eq!(range_of(source, *key).0, *text, "{} in {source}", key.as_str());
        }
    }

    #[test]
    fn a_range_in_a_literal_is_the_token_of_the_feature() {
        let cases: &[(FeatureId, &str, &str)] = &[
            (LOOKBEHIND, "/a(?<!b)/;", "(?<!"),
            (MODIFIERS, "/(?i-m:a)/;", "(?i-m:"),
            (NAMED_GROUP, r"/(?<\u{61}>a)/u;", r"(?<\u{61}>"),
            (CODE_POINT_ESCAPE, r"/(?<\u{61}>a)/u;", r"\u{61}"),
            (CODE_POINT_ESCAPE, r"/(?<a>x)\k<\u{61}>|(?<\u{61}>y)/u;", r"\u{61}"),
            (HAS_INDICES, "/a/dgimsuy;", "d"),
            (DOT_ALL, "/a/dgimsuy;", "s"),
            (UNICODE, "/a/dgimsuy;", "u"),
            (STICKY, "/a/dgimsuy;", "y"),
            // Non-ASCII text before the token: offsets stay on character boundaries.
            (LOOKBEHIND, "/Мяу(?<=б)/u;", "(?<="),
            (UNICODE, "/Мяу(?<=б)/u;", "u"),
        ];
        for (key, source, text) in cases {
            assert_eq!(range_of(source, *key).0, *text, "{} in {source}", key.as_str());
        }
        // The second group with the name is the duplicate.
        assert_eq!(range_of("/(?<x>a)|(?<x>b)/;", DUPLICATE_NAMED_GROUPS).1, 9);
        // The first use of a feature in the pattern gives the range.
        assert_eq!(range_of(r"/\p{L}\p{N}/u;", PROPERTY_ESCAPE), (r"\p{L}".to_string(), 1));
    }

    #[test]
    fn a_range_in_a_call_is_the_token_when_the_argument_is_written_as_its_value() {
        let cases: &[(FeatureId, &str, &str)] = &[
            (LOOKBEHIND, "new RegExp('(?<=a)b', 'v');", "(?<="),
            (UNICODE_SETS, "new RegExp('(?<=a)b', 'v');", "v"),
            (LOOKBEHIND, "new RegExp(`(?<=a)`);", "(?<="),
            (UNICODE_SETS, "new RegExp('a', `v`);", "v"),
            (LOOKBEHIND, r"new RegExp(String.raw`\d(?<=a)`, 'y');", "(?<="),
            (STICKY, r"new RegExp(String.raw`\d(?<=a)`, 'y');", "y"),
            (DOT_ALL, r"RegExp('a\\u{2}', 'su');", "s"),
            (UNICODE, r"RegExp('a\\u{2}', 'su');", "u"),
            // The new flags parse the source of the literal again; its pattern is in the file as written.
            (CODE_POINT_ESCAPE, r"RegExp(/\u{61}/, 'u');", r"\u{61}"),
            (UNICODE_SETS, "RegExp(/a/, 'v');", "v"),
            // An escape in the string: the value differs from the written text, so the range is the argument.
            (CODE_POINT_ESCAPE, r"RegExp('a\\u{2}', 'su');", r"'a\\u{2}'"),
            (NAMED_GROUP, r#"RegExp("(?<a>x)\x41", "d");"#, r#""(?<a>x)\x41""#),
            (HAS_INDICES, r#"RegExp("(?<a>x)\x41", "d");"#, "d"),
            (UNICODE_SETS, r#"RegExp('a', "\u0076");"#, r#""\u0076""#),
            (LOOKBEHIND, "RegExp('Мяу(?<=б)', 'u');", "(?<="),
        ];
        for (key, source, text) in cases {
            assert_eq!(range_of(source, *key).0, *text, "{} in {source}", key.as_str());
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
        assert!(references.0.named_reference.is_some(), "{text}");
        references.0.code_point_escape.is_some()
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

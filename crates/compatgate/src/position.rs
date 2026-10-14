//! Converts UTF-8 byte offsets from oxc into lines and UTF-16 columns, as ESLint and bundlers expect.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Position {
    /// Starts at 1.
    pub line: u32,
    /// Starts at 0. Counted in UTF-16 code units.
    pub column: u32,
    /// UTF-16 code units from the start of the source, as an index into a JavaScript string.
    /// Unlike `column`, it counts the byte order mark: a caller slices the string it passed in.
    pub offset: u32,
}

pub(crate) struct LineIndex<'a> {
    source: &'a str,
    /// Byte offset of the first character of each line.
    line_starts: Vec<u32>,
    /// Checkpoints for lines that hold non-ASCII text, so a column costs at most `CHECKPOINT_STEP` bytes to count.
    checkpoints: Vec<Checkpoint>,
    /// Line `n` owns `checkpoints[checkpoint_starts[n]..checkpoint_starts[n + 1]]`. The range is empty for ASCII lines.
    checkpoint_starts: Vec<u32>,
    /// UTF-16 offset of the first character of each line.
    line_offsets: Vec<u32>,
}

/// Distance in bytes between two checkpoints.
const CHECKPOINT_STEP: usize = 1024;

#[derive(Clone, Copy)]
struct Checkpoint {
    byte: u32,
    /// UTF-16 units between the line start and `byte`.
    column: u32,
}

impl<'a> LineIndex<'a> {
    pub(crate) fn new(source: &'a str) -> Self {
        let bytes = source.as_bytes();
        let mut line_starts = vec![0];
        // The "\n" of a "\r\n" pair belongs to the terminator that the "\r" starts.
        let mut pair_end = 0;
        // Every terminator starts with one of these bytes. The search skips the other bytes many at a time.
        for index in memchr::memchr3_iter(b'\n', b'\r', 0xE2, bytes) {
            if index < pair_end {
                continue;
            }
            let next = match bytes[index] {
                b'\r' if bytes.get(index + 1) == Some(&b'\n') => index + 2,
                b'\n' | b'\r' => index + 1,
                // U+2028 and U+2029 are line terminators in JavaScript. In UTF-8 they are E2 80 A8 and E2 80 A9.
                // Other characters, such as U+2026, start with E2 too.
                _ if bytes.get(index + 1) == Some(&0x80) && matches!(bytes.get(index + 2), Some(0xA8 | 0xA9)) => {
                    index + 3
                }
                _ => continue,
            };
            line_starts.push(next as u32);
            pair_end = next;
        }
        let (checkpoints, checkpoint_starts, line_offsets) = Self::build_checkpoints(source, &line_starts);
        Self {
            source,
            line_starts,
            checkpoints,
            checkpoint_starts,
            line_offsets,
        }
    }

    /// One pass over the lines. A line gets checkpoints only if it has a non-ASCII byte.
    /// The pass also sums the UTF-16 length of the lines into the offset of each line.
    fn build_checkpoints(source: &str, line_starts: &[u32]) -> (Vec<Checkpoint>, Vec<u32>, Vec<u32>) {
        let bytes = source.as_bytes();
        let mut checkpoints = Vec::new();
        let mut per_line = Vec::with_capacity(line_starts.len() + 1);
        let mut line_offsets = Vec::with_capacity(line_starts.len());
        let mut line_offset = 0u32;
        // The first non-ASCII byte from the current line on. Most lines of a bundle are ASCII, and one search
        // over many of them costs less than a check of each line.
        let mut next_wide = next_non_ascii(bytes, 0);
        for (line, &start) in line_starts.iter().enumerate() {
            line_offsets.push(line_offset);
            let mut start = start as usize;
            // ESLint removes the byte order mark before it counts columns, so it is not a column here either.
            if line == 0 && source.starts_with('\u{FEFF}') {
                start = '\u{FEFF}'.len_utf8();
                line_offset += 1;
            }
            let end = line_starts.get(line + 1).map_or(source.len(), |&next| next as usize);
            per_line.push(checkpoints.len() as u32);
            if next_wide < start {
                next_wide = next_non_ascii(bytes, start);
            }
            if next_wide >= end {
                line_offset += (end - start) as u32;
                continue;
            }
            let line_bytes = &bytes[start..end];
            // A checkpoint at the line start, then one at the first character that starts at least
            // `CHECKPOINT_STEP` bytes after the previous checkpoint.
            let mut column = 0u32;
            let mut mark = 0usize;
            loop {
                checkpoints.push(Checkpoint {
                    byte: (start + mark) as u32,
                    column,
                });
                let mut next = mark + CHECKPOINT_STEP;
                while next < line_bytes.len() && !starts_char(line_bytes[next]) {
                    next += 1;
                }
                if next >= line_bytes.len() {
                    column += utf16_len(&line_bytes[mark..]);
                    break;
                }
                column += utf16_len(&line_bytes[mark..next]);
                mark = next;
            }
            line_offset += column;
        }
        per_line.push(checkpoints.len() as u32);
        (checkpoints, per_line, line_offsets)
    }

    pub(crate) fn position(&self, offset: u32) -> Position {
        count!(positions);
        let line = self.line_starts.partition_point(|&start| start <= offset) - 1;
        let mut start = self.line_starts[line];
        // The mark is one UTF-16 unit before the first column, except for an offset inside the mark itself.
        let mut bom = 0;
        if line == 0 && self.source.starts_with('\u{FEFF}') {
            start = start.max('\u{FEFF}'.len_utf8() as u32).min(offset);
            bom = u32::from(start > 0);
        }
        let (first, end) = (self.checkpoint_starts[line], self.checkpoint_starts[line + 1]);
        let column = match first < end {
            true if offset > start => {
                let marks = &self.checkpoints[first as usize..end as usize];
                // The first checkpoint sits at the line start, past the BOM, and `offset > start` here.
                let mark = marks[marks.partition_point(|mark| mark.byte <= offset).max(1) - 1];
                count!(positions, (offset - mark.byte) as usize);
                mark.column + utf16_len(&self.source.as_bytes()[mark.byte as usize..offset as usize])
            }
            _ => offset - start,
        };
        Position {
            line: line as u32 + 1,
            column,
            offset: self.line_offsets[line] + bom + column,
        }
    }
}

/// The offset of the first byte from `from` on that is not ASCII, or the length of `bytes`.
fn next_non_ascii(bytes: &[u8], from: usize) -> usize {
    // `is_ascii` checks a word at a time, so it skips an ASCII block fast.
    let mut offset = from;
    for block in bytes[from..].chunks(64) {
        if !block.is_ascii() {
            break;
        }
        offset += block.len();
    }
    // The block at `offset` holds the byte, or the search has reached the end.
    let rest = &bytes[offset..];
    offset + rest.iter().position(|byte| !byte.is_ascii()).unwrap_or(rest.len())
}

/// The byte is not a continuation byte of UTF-8, so a character starts at it.
fn starts_char(byte: u8) -> bool {
    (byte as i8) >= -0x40
}

/// UTF-16 length of whole UTF-8 characters: one unit for each character, two for each four-byte character.
/// It counts bytes without decoding, so the compiler can vectorize the loop.
fn utf16_len(bytes: &[u8]) -> u32 {
    bytes
        .iter()
        .map(|&byte| u32::from(starts_char(byte)) + u32::from(byte >= 0xF0))
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Line and column of the first `needle`.
    fn at(source: &str, needle: &str) -> (u32, u32) {
        let position = LineIndex::new(source).position(source.find(needle).unwrap() as u32);
        (position.line, position.column)
    }

    fn offset(source: &str, needle: &str) -> u32 {
        LineIndex::new(source)
            .position(source.find(needle).unwrap() as u32)
            .offset
    }

    #[test]
    fn first_line_starts_at_one() {
        assert_eq!(at("abc", "b"), (1, 1));
    }

    #[test]
    fn counts_all_line_terminators() {
        assert_eq!(at("a\nb", "b"), (2, 0));
        assert_eq!(at("a\r\nb", "b"), (2, 0));
        assert_eq!(at("a\rb", "b"), (2, 0));
        assert_eq!(at("a\u{2028}b", "b"), (2, 0));
        assert_eq!(at("a\u{2029}b", "b"), (2, 0));
    }

    #[test]
    fn columns_are_utf16_units() {
        assert_eq!(at("привет x", "x"), (1, 7));
        assert_eq!(at("😀x", "x"), (1, 2));
    }

    #[test]
    fn end_of_source_is_a_valid_offset() {
        let source = "ab\n";
        assert_eq!(
            LineIndex::new(source).position(3),
            Position {
                line: 2,
                column: 0,
                offset: 3
            }
        );
    }

    #[test]
    fn byte_order_mark_is_not_a_column() {
        assert_eq!(at("\u{FEFF}ab", "b"), (1, 1));
        assert_eq!(at("\u{FEFF}a\nb", "b"), (2, 0));
        assert_eq!(at("\u{FEFF}привет x", "x"), (1, 7));
    }

    #[test]
    fn offsets_are_utf16_units_from_the_source_start() {
        assert_eq!(offset("ab\ncd", "d"), 4);
        assert_eq!(offset("привет\n😀x", "x"), 9);
        assert_eq!(offset("a\r\nb\u{2028}c", "c"), 5);
    }

    #[test]
    fn the_byte_order_mark_counts_in_the_offset() {
        // The offset indexes the source string as JavaScript sees it, the mark included.
        assert_eq!(offset("\u{FEFF}ab", "b"), 2);
        assert_eq!(offset("\u{FEFF}привет\nx", "x"), 8);
        assert_eq!(LineIndex::new("\u{FEFF}a").position(0).offset, 0);
    }

    /// Line, column and offset of a byte offset.
    fn triple(source: &str, offset: u32) -> (u32, u32, u32) {
        let position = LineIndex::new(source).position(offset);
        (position.line, position.column, position.offset)
    }

    #[test]
    fn an_empty_source_has_one_line() {
        assert_eq!(triple("", 0), (1, 0, 0));
        assert_eq!(triple("\u{FEFF}", 0), (1, 0, 0));
        assert_eq!(triple("\u{FEFF}", 3), (1, 0, 1));
    }

    #[test]
    fn the_last_line_may_lack_a_terminator() {
        assert_eq!(triple("a\nbc", 3), (2, 1, 3));
        assert_eq!(triple("a\nbc", 4), (2, 2, 4));
        assert_eq!(triple("a\r", 2), (2, 0, 2));
        assert_eq!(triple("a\u{2029}", 4), (2, 0, 2));
    }

    #[test]
    fn a_crlf_pair_ends_one_line() {
        // The "\n" of the pair belongs to the line that the "\r" ends, as in ESLint.
        assert_eq!(triple("a\r\nb", 1), (1, 1, 1));
        assert_eq!(triple("a\r\nb", 2), (1, 2, 2));
        assert_eq!(triple("a\r\nb", 3), (2, 0, 3));
        assert_eq!(at("\r\n\r\nx", "x"), (3, 0));
        // "\n\r" is two terminators, and so are two lone "\r".
        assert_eq!(at("\n\rx", "x"), (3, 0));
        assert_eq!(at("\r\rx", "x"), (3, 0));
        assert_eq!(at("\n\nx", "x"), (3, 0));
        assert_eq!(at("\r\u{2028}x", "x"), (3, 0));
    }

    #[test]
    fn other_characters_that_start_with_e2_end_no_line() {
        // U+2026 is E2 80 A6 and U+2030 is E2 80 B0 in UTF-8; U+2028 is E2 80 A8.
        assert_eq!(at("\u{2026}\u{2030}x", "x"), (1, 2));
        assert_eq!(at("\u{2027}\u{202A}x", "x"), (1, 2));
        assert_eq!(at("\u{2328}x", "x"), (1, 1));
    }

    #[test]
    fn non_bmp_characters_take_two_units_on_any_line() {
        assert_eq!(at("a\n😀😀x", "x"), (2, 4));
        assert_eq!(offset("a\n😀😀x", "x"), 6);
        assert_eq!(at("\u{FEFF}😀\r\n𝒳x", "x"), (2, 2));
        assert_eq!(offset("\u{FEFF}😀\r\n𝒳x", "x"), 7);
    }

    /// Positions by the JavaScript rules, char by char: "\r\n" is one terminator, and so are
    /// "\n", "\r", U+2028 and U+2029. A byte order mark is no column.
    fn reference(source: &str, offset: usize) -> Position {
        let mut starts = vec![0];
        let mut chars = source.char_indices().peekable();
        while let Some((index, ch)) = chars.next() {
            match ch {
                '\r' if chars.peek().is_some_and(|&(_, next)| next == '\n') => {
                    chars.next();
                    starts.push(index + 2);
                }
                '\n' | '\r' | '\u{2028}' | '\u{2029}' => starts.push(index + ch.len_utf8()),
                _ => {}
            }
        }
        let line = starts.iter().filter(|&&start| start <= offset).count();
        let mut start = starts[line - 1];
        if line == 1 && source.starts_with('\u{FEFF}') && offset >= start + 3 {
            start += 3;
        }
        Position {
            line: line as u32,
            column: source[start..offset].encode_utf16().count() as u32,
            offset: source[..offset].encode_utf16().count() as u32,
        }
    }

    #[test]
    fn every_offset_matches_the_reference() {
        let pieces = [
            "a", "\n", "\r", "\r\n", "\u{2028}", "\u{2029}", "\u{2026}", "п", "😀", "  ", "\n\r", "\r\r",
        ];
        for (first, step) in [(0, 1), (3, 5), (7, 11)] {
            let mut source = String::from(if first == 3 { "\u{FEFF}" } else { "" });
            for k in 0..600 {
                source.push_str(pieces[(first + k * step) % pieces.len()]);
            }
            // A long line with non-ASCII text, so that a column counts from a checkpoint.
            source.push_str(&"привет😀x ".repeat(400));
            source.push('\r');
            let index = LineIndex::new(&source);
            for offset in (0..=source.len()).filter(|&i| source.is_char_boundary(i)) {
                assert_eq!(
                    index.position(offset as u32),
                    reference(&source, offset),
                    "offset {offset}"
                );
            }
        }
    }

    fn naive(source: &str, offset: usize) -> Position {
        let before = &source[..offset];
        let mut line = 1;
        let mut start = 0;
        let bytes = before.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            match bytes[i] {
                b'\n' => {
                    line += 1;
                    start = i + 1;
                }
                b'\r' => {
                    if bytes.get(i + 1) == Some(&b'\n') {
                        i += 1;
                    }
                    line += 1;
                    start = i + 1;
                }
                _ => {}
            }
            i += 1;
        }
        Position {
            line,
            column: source[start..offset].encode_utf16().count() as u32,
            offset: source[..offset].encode_utf16().count() as u32,
        }
    }

    fn check_equivalence(source: &str) {
        let index = LineIndex::new(source);
        let boundaries: Vec<usize> = (0..=source.len()).filter(|&i| source.is_char_boundary(i)).collect();
        for k in 0..100 {
            let offset = boundaries[(boundaries.len() - 1) * k / 99];
            assert_eq!(index.position(offset as u32), naive(source, offset), "offset {offset}");
        }
    }

    #[test]
    fn long_ascii_line_matches_naive_count() {
        check_equivalence(&"abcdefgh".repeat(131_072));
    }

    #[test]
    fn long_mixed_line_matches_naive_count() {
        check_equivalence(&"привет😀x".repeat(70_000));
    }

    #[test]
    fn a_position_in_a_long_line_costs_at_most_one_checkpoint_step() {
        // Counting a column from the line start costs the whole line. The checkpoints bound the count
        // by `CHECKPOINT_STEP` bytes, whatever the length of the line. The second line is four times
        // longer than the first: a count from the line start breaks the bound on both.
        const LOOKUPS: usize = 10_000;
        for repeats in [10_000, 40_000] {
            let source = "привет😀x".repeat(repeats);
            let index = LineIndex::new(&source);
            let boundaries: Vec<usize> = (0..=source.len()).filter(|&i| source.is_char_boundary(i)).collect();
            crate::counters::take();
            for k in 0..LOOKUPS {
                let offset = boundaries[(boundaries.len() - 1) * k / (LOOKUPS - 1)];
                index.position(offset as u32);
            }
            // One step for the lookup, the bytes after the checkpoint, and at most one character
            // that crosses the checkpoint mark.
            let steps = crate::counters::take().positions;
            assert!(
                steps <= LOOKUPS * (1 + CHECKPOINT_STEP + 4),
                "{repeats} repeats: {steps} steps"
            );
        }
    }
}

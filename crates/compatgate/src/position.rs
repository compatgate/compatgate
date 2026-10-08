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

pub struct LineIndex<'a> {
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
    pub fn new(source: &'a str) -> Self {
        let bytes = source.as_bytes();
        let mut line_starts = vec![0];
        let mut index = 0;
        while index < bytes.len() {
            match bytes[index] {
                b'\n' => line_starts.push(index as u32 + 1),
                b'\r' => {
                    if bytes.get(index + 1) == Some(&b'\n') {
                        index += 1;
                    }
                    line_starts.push(index as u32 + 1);
                }
                // U+2028 and U+2029 are line terminators in JavaScript. In UTF-8 they are E2 80 A8 and E2 80 A9.
                0xE2 if bytes.get(index + 1) == Some(&0x80) && matches!(bytes.get(index + 2), Some(0xA8 | 0xA9)) => {
                    index += 2;
                    line_starts.push(index as u32 + 1);
                }
                _ => {}
            }
            index += 1;
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

    /// One pass over the source. A line gets checkpoints only if it has a non-ASCII byte.
    /// The pass also sums the UTF-16 length of the lines into the offset of each line.
    fn build_checkpoints(source: &str, line_starts: &[u32]) -> (Vec<Checkpoint>, Vec<u32>, Vec<u32>) {
        let mut checkpoints = Vec::new();
        let mut per_line = Vec::with_capacity(line_starts.len());
        let mut line_offsets = Vec::with_capacity(line_starts.len());
        let mut line_offset = 0u32;
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
            if source.as_bytes()[start..end].is_ascii() {
                line_offset += (end - start) as u32;
                continue;
            }
            let mut column = 0u32;
            let mut next_mark = 0usize;
            for (offset, ch) in source[start..end].char_indices() {
                if offset >= next_mark {
                    checkpoints.push(Checkpoint {
                        byte: (start + offset) as u32,
                        column,
                    });
                    next_mark = offset + CHECKPOINT_STEP;
                }
                column += ch.len_utf16() as u32;
            }
            line_offset += column;
        }
        per_line.push(checkpoints.len() as u32);
        (checkpoints, per_line, line_offsets)
    }

    pub fn position(&self, offset: u32) -> Position {
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
                mark.column + self.source[mark.byte as usize..offset as usize].encode_utf16().count() as u32
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

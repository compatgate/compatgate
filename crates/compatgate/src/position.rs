//! Converts UTF-8 byte offsets from oxc into lines and UTF-16 columns, as ESLint and bundlers expect.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Position {
    /// Starts at 1.
    pub line: u32,
    /// Starts at 0. Counted in UTF-16 code units.
    pub column: u32,
}

pub struct LineIndex<'a> {
    source: &'a str,
    /// Byte offset of the first character of each line.
    line_starts: Vec<u32>,
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
        Self { source, line_starts }
    }

    pub fn position(&self, offset: u32) -> Position {
        let line = self.line_starts.partition_point(|&start| start <= offset) - 1;
        let start = self.line_starts[line] as usize;
        let column = self.source[start..offset as usize].encode_utf16().count() as u32;
        Position { line: line as u32 + 1, column }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(source: &str, needle: &str) -> Position {
        LineIndex::new(source).position(source.find(needle).unwrap() as u32)
    }

    #[test]
    fn first_line_starts_at_one() {
        assert_eq!(at("abc", "b"), Position { line: 1, column: 1 });
    }

    #[test]
    fn counts_all_line_terminators() {
        assert_eq!(at("a\nb", "b"), Position { line: 2, column: 0 });
        assert_eq!(at("a\r\nb", "b"), Position { line: 2, column: 0 });
        assert_eq!(at("a\rb", "b"), Position { line: 2, column: 0 });
        assert_eq!(at("a\u{2028}b", "b"), Position { line: 2, column: 0 });
        assert_eq!(at("a\u{2029}b", "b"), Position { line: 2, column: 0 });
    }

    #[test]
    fn columns_are_utf16_units() {
        assert_eq!(at("привет x", "x"), Position { line: 1, column: 7 });
        assert_eq!(at("😀x", "x"), Position { line: 1, column: 2 });
    }

    #[test]
    fn end_of_source_is_a_valid_offset() {
        let source = "ab\n";
        assert_eq!(LineIndex::new(source).position(3), Position { line: 2, column: 0 });
    }
}

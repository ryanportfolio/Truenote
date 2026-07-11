export interface TextRange {
  startOffset: number;
  endOffset: number;
}

export interface AnchoredTextRange extends TextRange {
  highlightedText: string;
}

/** Remove accidental edge whitespace while keeping UTF-16 DOM offsets aligned. */
export function trimSelectedRange(
  rawText: string,
  rawStartOffset: number
): AnchoredTextRange | null {
  const leadingWhitespace = rawText.match(/^\s*/u)?.[0].length ?? 0;
  const trailingWhitespace = rawText.match(/\s*$/u)?.[0].length ?? 0;
  const highlightedText = rawText.slice(
    leadingWhitespace,
    rawText.length - trailingWhitespace
  );
  if (highlightedText.length === 0) return null;
  const startOffset = rawStartOffset + leadingWhitespace;
  return {
    highlightedText,
    startOffset,
    endOffset: startOffset + highlightedText.length
  };
}

export function rangesOverlap(a: TextRange, b: TextRange): boolean {
  return a.startOffset < b.endOffset && a.endOffset > b.startOffset;
}

/** Offsets are only safe to render when the saved quote still matches exactly. */
export function rangeMatchesText(
  content: string,
  range: AnchoredTextRange
): boolean {
  if (
    range.startOffset < 0 ||
    range.endOffset <= range.startOffset ||
    range.endOffset > content.length
  ) {
    return false;
  }
  return content.slice(range.startOffset, range.endOffset) === range.highlightedText;
}

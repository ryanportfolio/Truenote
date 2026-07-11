/**
 * Semantic chunker for markdown.
 *
 * Contract (.claude/reference/ingestion.md):
 *   - Target ~500 tokens.
 *   - Never split inside a markdown table.
 *   - Never split mid-list.
 *   - Prefer header boundaries.
 *
 * Strategy:
 *   1. Tokenize markdown into structural segments — heading, table, list,
 *      code-fenced block, paragraph. Tables and lists are atomic units.
 *   2. Pack segments greedily up to targetTokens. A heading always starts a
 *      new chunk (so the chunk contains the heading + the content under it
 *      for as long as it fits).
 *   3. If a single table or list exceeds targetTokens, emit it as a solo
 *      chunk regardless — preserving atomicity wins over hitting the target.
 *
 * The tokenize fn is injected so tests don't depend on js-tiktoken being
 * loadable. Real ingestion code uses createTiktokenTokenizer() from
 * ./tokenizer.
 */

export type Tokenize = (text: string) => number;

export interface ChunkMetadata {
  heading_path?: string[];
  token_count?: number;
  segment_types?: string[];
  /** UTF-16 offsets into document_versions.parsed_markdown. End is exclusive. */
  source_start?: number;
  source_end?: number;
}

export interface Chunk {
  ordinal: number;
  content: string;
  metadata: ChunkMetadata;
}

export interface ChunkerOptions {
  /** Soft target token count per chunk. Default 500. */
  targetTokens?: number;
  tokenize: Tokenize;
}

type SegmentType = "heading" | "table" | "list" | "paragraph" | "code";

interface Segment {
  type: SegmentType;
  content: string;
  /** Raw source bounds before chunk content normalizes blank-line spacing. */
  sourceStart: number;
  sourceEnd: number;
  /** Heading level 1-6, only set when type === "heading". */
  level?: number;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^```/;
const FENCE_CLOSE_RE = /^```\s*$/;
const TABLE_LINE_RE = /^\s*\|.*\|\s*$/;
const LIST_LINE_RE = /^\s*([-*+]|\d+\.)\s+/;
const LIST_CONTINUATION_RE = /^\s{2,}\S/;

export function extractSegments(markdown: string): Segment[] {
  const lines = markdown.split("\n");
  const lineStarts: number[] = [];
  let cursor = 0;
  for (let index = 0; index < lines.length; index += 1) {
    lineStarts.push(cursor);
    cursor += (lines[index]?.length ?? 0) + (index < lines.length - 1 ? 1 : 0);
  }
  const segments: Segment[] = [];
  let i = 0;

  const sourceBounds = (
    startLine: number,
    endLineExclusive: number
  ): { sourceStart: number; sourceEnd: number } => {
    const lastLine = Math.max(startLine, endLineExclusive - 1);
    return {
      sourceStart: lineStarts[startLine] ?? markdown.length,
      sourceEnd:
        (lineStarts[lastLine] ?? markdown.length) + (lines[lastLine]?.length ?? 0)
    };
  };

  const pushParagraph = (start: number, end: number): void => {
    const text = lines.slice(start, end).join("\n").trim();
    if (text.length > 0) {
      segments.push({
        type: "paragraph",
        content: text,
        ...sourceBounds(start, end)
      });
    }
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Heading
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const hashes = heading[1] ?? "";
      segments.push({
        type: "heading",
        content: line,
        ...sourceBounds(i, i + 1),
        level: hashes.length
      });
      i++;
      continue;
    }

    // Code fence — consume until matching close (or EOF).
    if (FENCE_RE.test(line)) {
      const start = i;
      i++;
      while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i] ?? "")) i++;
      if (i < lines.length) i++; // consume closing fence
      segments.push({
        type: "code",
        content: lines.slice(start, i).join("\n"),
        ...sourceBounds(start, i)
      });
      continue;
    }

    // Table — run of lines starting with `|`. Tables stay atomic.
    if (TABLE_LINE_RE.test(line)) {
      const start = i;
      while (i < lines.length && TABLE_LINE_RE.test(lines[i] ?? "")) i++;
      segments.push({
        type: "table",
        content: lines.slice(start, i).join("\n"),
        ...sourceBounds(start, i)
      });
      continue;
    }

    // List — list lines plus their indented continuations, terminated by two
    // consecutive blank lines or a non-list block start.
    if (LIST_LINE_RE.test(line)) {
      const start = i;
      while (i < lines.length) {
        const cur = lines[i] ?? "";
        if (cur.trim() === "") {
          const next = lines[i + 1] ?? "";
          if (next.trim() === "" || !LIST_LINE_RE.test(next) && !LIST_CONTINUATION_RE.test(next)) {
            break;
          }
          i++;
          continue;
        }
        if (!LIST_LINE_RE.test(cur) && !LIST_CONTINUATION_RE.test(cur)) break;
        i++;
      }
      // Trim trailing blank lines.
      let end = i;
      while (end > start && (lines[end - 1] ?? "").trim() === "") end--;
      segments.push({
        type: "list",
        content: lines.slice(start, end).join("\n"),
        ...sourceBounds(start, end)
      });
      continue;
    }

    // Paragraph — consume up to blank line or a structural boundary.
    const start = i;
    while (i < lines.length) {
      const cur = lines[i] ?? "";
      if (cur.trim() === "") break;
      if (HEADING_RE.test(cur)) break;
      if (FENCE_RE.test(cur)) break;
      if (TABLE_LINE_RE.test(cur)) break;
      if (LIST_LINE_RE.test(cur)) break;
      i++;
    }
    pushParagraph(start, i);
    while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
  }

  return segments;
}

/** Rebuild the exact normalized body shape the chunk packer stores. */
export function canonicalChunkContent(markdown: string): string {
  return extractSegments(markdown)
    .map((segment) => segment.content)
    .join("\n\n")
    .trim();
}

function updateHeadingPath(path: string[], level: number, text: string): string[] {
  const next = path.slice(0, level - 1);
  while (next.length < level - 1) next.push("");
  next.push(text);
  return next;
}

export function chunkMarkdown(markdown: string, options: ChunkerOptions): Chunk[] {
  const target = options.targetTokens ?? 500;
  const tokenize = options.tokenize;
  const segments = extractSegments(markdown);
  const chunks: Chunk[] = [];

  let buf: Segment[] = [];
  let bufTokens = 0;
  let bufTypes: SegmentType[] = [];
  let headingPath: string[] = [];
  let bufHeadingPath: string[] = [];

  const flush = (): void => {
    if (buf.length === 0) return;
    const content = buf.map((s) => s.content).join("\n\n").trim();
    if (content.length === 0) {
      buf = [];
      bufTokens = 0;
      bufTypes = [];
      return;
    }
    chunks.push({
      ordinal: chunks.length,
      content,
      metadata: {
        heading_path: [...bufHeadingPath],
        token_count: bufTokens,
        segment_types: [...bufTypes],
        source_start: buf[0]?.sourceStart,
        source_end: buf[buf.length - 1]?.sourceEnd
      }
    });
    buf = [];
    bufTokens = 0;
    bufTypes = [];
  };

  for (const seg of segments) {
    const segTokens = tokenize(seg.content);

    if (seg.type === "heading") {
      // Header boundary: always start a new chunk.
      flush();
      const headingText = seg.content.replace(/^#+\s+/, "").trim();
      headingPath = updateHeadingPath(headingPath, seg.level ?? 1, headingText);
      bufHeadingPath = [...headingPath];
      buf.push(seg);
      bufTokens += segTokens;
      bufTypes.push(seg.type);
      continue;
    }

    // Atomic giant block (table or list exceeding target alone) — emit solo.
    if ((seg.type === "table" || seg.type === "list") && segTokens >= target) {
      flush();
      bufHeadingPath = [...headingPath];
      buf.push(seg);
      bufTokens = segTokens;
      bufTypes = [seg.type];
      flush();
      continue;
    }

    if (bufTokens + segTokens > target && bufTokens > 0) {
      flush();
      bufHeadingPath = [...headingPath];
    }

    if (buf.length === 0) bufHeadingPath = [...headingPath];
    buf.push(seg);
    bufTokens += segTokens;
    bufTypes.push(seg.type);
  }
  flush();
  return chunks;
}

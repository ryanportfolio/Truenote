/**
 * Split one compliance document into citable passages for the compliance
 * assistant (lib/compliance/ask.ts).
 *
 * A passage never crosses a heading, so each carries one section path
 * ("Access control > Account management"). Long sections split at blank
 * lines; a block longer than the cap (a large table, usually) splits at line
 * boundaries, and each table piece after the first repeats the table's header
 * rows in its text so the excerpt still reads as a table.
 *
 * sourceStart/sourceEnd are UTF-16 offsets into the exact Markdown served by
 * GET /api/compliance/documents/:slug, the same offsets react-markdown reports
 * for its nodes, so the document view can mark the cited passage.
 */
import { createHash } from "node:crypto";
import type { ComplianceManifestEntry } from "./documents.js";

/** Bump when passage boundaries change: it is part of the vector cache key. */
export const COMPLIANCE_CHUNKER_VERSION = 1;

const MAX_PASSAGE_CHARS = 1_500;

export interface CompliancePassage {
  /** UUID-shaped and stable for one document version and position. */
  id: string;
  slug: string;
  title: string;
  version: string;
  sha256: string;
  /** Heading path, "" before the first heading. */
  section: string;
  /** Position within the document, 0-based. */
  ordinal: number;
  /** Raw Markdown of the passage (plus repeated table header rows, see above). */
  content: string;
  sourceStart: number;
  sourceEnd: number;
}

interface Line {
  text: string;
  start: number;
  end: number;
}

function splitLines(markdown: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start <= markdown.length) {
    const newline = markdown.indexOf("\n", start);
    const end = newline === -1 ? markdown.length : newline;
    const text = markdown.slice(start, end).replace(/\r$/, "");
    lines.push({ text, start, end: start + text.length });
    if (newline === -1) break;
    start = newline + 1;
  }
  return lines;
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t#]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Heading text without inline Markdown emphasis or code marks. */
function headingText(raw: string): string {
  return raw.replace(/[*_`]/g, "").trim();
}

export function passageId(sha256: string, ordinal: number): string {
  const hex = createHash("sha256").update(`${sha256}:${ordinal}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

interface Block {
  lines: Line[];
  /** Header and separator rows when the block is a table. */
  tableHeader: Line[] | null;
}

/** Group a section's lines into blocks separated by blank lines (fences kept whole). */
function blocksOf(lines: Line[]): Block[] {
  const blocks: Block[] = [];
  let current: Line[] = [];
  let fence: string | null = null;
  const flush = (): void => {
    if (current.length === 0) return;
    const [first, second] = current;
    const isTable =
      first !== undefined &&
      second !== undefined &&
      first.text.includes("|") &&
      TABLE_SEPARATOR.test(second.text);
    blocks.push({ lines: current, tableHeader: isTable ? [first, second] : null });
    current = [];
  };
  for (const line of lines) {
    const fenceMatch = FENCE.exec(line.text);
    if (fence) {
      current.push(line);
      if (fenceMatch && fenceMatch[1]!.startsWith(fence[0]!) && fenceMatch[1]!.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      current.push(line);
      continue;
    }
    if (line.text.trim() === "") {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

interface Piece {
  lines: Line[];
  /** Table header rows to prepend to the text, when this piece continues a table. */
  repeatHeader: Line[] | null;
}

/** Split a block longer than the cap at line boundaries. */
function piecesOf(block: Block): Piece[] {
  const size = (lines: Line[]): number =>
    lines.reduce((total, line) => total + line.text.length + 1, 0);
  if (size(block.lines) <= MAX_PASSAGE_CHARS) return [{ lines: block.lines, repeatHeader: null }];
  const pieces: Piece[] = [];
  let current: Line[] = [];
  for (const line of block.lines) {
    if (current.length > 0 && size(current) + line.text.length + 1 > MAX_PASSAGE_CHARS) {
      pieces.push({ lines: current, repeatHeader: pieces.length > 0 ? block.tableHeader : null });
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) {
    pieces.push({ lines: current, repeatHeader: pieces.length > 0 ? block.tableHeader : null });
  }
  return pieces;
}

export function chunkComplianceDocument(
  entry: Pick<ComplianceManifestEntry, "slug" | "title" | "version" | "sha256">,
  markdown: string
): CompliancePassage[] {
  // Sections: runs of lines between headings, outside fenced code.
  const sections: Array<{ path: string; lines: Line[] }> = [];
  const stack: Array<{ depth: number; text: string }> = [];
  let current: { path: string; lines: Line[] } = { path: "", lines: [] };
  let fence: string | null = null;
  for (const line of splitLines(markdown)) {
    const fenceMatch = FENCE.exec(line.text);
    if (fence) {
      if (fenceMatch && fenceMatch[1]!.startsWith(fence[0]!) && fenceMatch[1]!.length >= fence.length) {
        fence = null;
      }
      current.lines.push(line);
      continue;
    }
    if (fenceMatch) fence = fenceMatch[1]!;
    const heading = fence ? null : HEADING.exec(line.text);
    if (heading) {
      if (current.lines.length > 0) sections.push(current);
      const depth = heading[1]!.length;
      while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) stack.pop();
      stack.push({ depth, text: headingText(heading[2]!) });
      current = { path: stack.map((item) => item.text).join(" > "), lines: [line] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.length > 0) sections.push(current);

  const passages: CompliancePassage[] = [];
  for (const section of sections) {
    // Pack whole blocks into passages up to the cap; oversized blocks split alone.
    let pending: Line[] = [];
    const emit = (lines: Line[], repeatHeader: Line[] | null): void => {
      const first = lines[0];
      const last = lines[lines.length - 1];
      if (!first || !last) return;
      // A heading directly followed by a subheading has nothing to cite.
      if (lines.length === 1 && HEADING.test(first.text)) return;
      const raw = markdown.slice(first.start, last.end);
      const content = repeatHeader
        ? `${repeatHeader.map((line) => line.text).join("\n")}\n${raw}`
        : raw;
      if (content.trim() === "") return;
      const ordinal = passages.length;
      passages.push({
        id: passageId(entry.sha256, ordinal),
        slug: entry.slug,
        title: entry.title,
        version: entry.version,
        sha256: entry.sha256,
        section: section.path,
        ordinal,
        content,
        sourceStart: first.start,
        sourceEnd: last.end
      });
    };
    const pendingSize = (): number =>
      pending.length === 0 ? 0 : pending[pending.length - 1]!.end - pending[0]!.start;
    for (const block of blocksOf(section.lines)) {
      const pieces = piecesOf(block);
      if (pieces.length > 1) {
        emit(pending, null);
        pending = [];
        for (const piece of pieces) emit(piece.lines, piece.repeatHeader);
        continue;
      }
      const blockSize = block.lines[block.lines.length - 1]!.end - block.lines[0]!.start;
      if (pending.length > 0 && pendingSize() + blockSize + 2 > MAX_PASSAGE_CHARS) {
        emit(pending, null);
        pending = [];
      }
      pending.push(...block.lines);
    }
    emit(pending, null);
  }
  return passages;
}

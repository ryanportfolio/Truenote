import type { RetrievalChunk } from "../retrieval/query.js";

/**
 * Per-claim figure grounding for generated answers. Runs on the normalized
 * answer, where every bracketed token is a canonical `[chunk-id]` citation.
 *
 * 0. Citations are read as the answer view rewrites them
 *    (`annotateCitations` in artifacts/rag-app): its bracket pattern runs
 *    over the raw answer, so `[note [id]` is one unknown token. A citation
 *    counts only where the CSR gets a clickable chip: not in code, raw HTML,
 *    an autolink or autolink literal, a link destination, after `\` or `!`,
 *    or in a table cell past the header's column count.
 * 1. Structure follows CommonMark block rules on the raw Markdown, as the
 *    CSR's renderer (react-markdown, micromark) reads it: containers
 *    (blockquotes, list items) are matched line by line, blank lines end
 *    paragraphs, and an ordered-list marker interrupts a paragraph only when
 *    it is `1.`/`1)`. A marker that does not start a list item stays
 *    paragraph text, so its number is a figure. Code, HTML and table lines
 *    are never read as list markers. A table ends with its container.
 * 2. Each block's content becomes the text the CSR sees: NFKC, format and
 *    other invisible characters removed, every space variant mapped to a
 *    space. It is read twice (see `VIEWS`): decoded with inline markup
 *    (`*`, `_`, `~`, backticks) removed, so `$9*5*` reads as `$95`, and raw
 *    with markup as a separator. Excerpts get the same normalization.
 * 3. Paragraphs, list items and headings split into sentences; table rows
 *    stay whole. Within a sentence each figure is credited to the first
 *    citation group after it, or, when none follows, the last group before
 *    it. A citation-only remainder joins the sentence before it. A sentence
 *    with no citation is checked against every excerpt the answer cites.
 *    A plain number or compound the CSR's question holds needs no excerpt.
 * 4. Figures are typed spans (currency, percentage, plain number, or a
 *    compound date/time/range/fraction/identifier) compared as exact
 *    canonical strings. Money words (`40 cents`) set the currency unit and
 *    scale words (`$40 million`, `$40k`) the value. A figure is grounded only
 *    when a cited excerpt holds a figure of the same kind, unit and value, so
 *    a plain number matches only a plain number. Numbers never match part of
 *    a compound, except that a number joined to a unit word (`30-day`,
 *    `50GB`) also reads as the plain number. A numeric character NFKC cannot map to ASCII digits, or a
 *    named character reference the gate cannot decode, rejects the answer.
 */

/**
 * The answer view's citation pattern (`CITATION_RE` in
 * artifacts/rag-app/src/lib/citation-rendering.ts). It runs over the whole
 * answer before Markdown parsing and may span lines, so `[note [id]` is one
 * unknown token, not a citation.
 */
const CITATION_MARKER = /\[([^\]]+)\]/g;
/** Citations are swapped for one private-use character each (index into the chunk list). */
const SENTINEL_BASE = 0xe000;
const SENTINEL_LIMIT = 0xf8ff;
const PRIVATE_USE = /\p{Co}/gu;
const SENTINEL = /[\ue000-\uf8ff]/;
const SENTINEL_ALL = /[\ue000-\uf8ff]/g;
const SENTINEL_GROUP = /[\ue000-\uf8ff](?:[\s,;]*[\ue000-\uf8ff])*/g;

// ---------------------------------------------------------------------------
// Block structure (CommonMark container and leaf rules, simplified)
// ---------------------------------------------------------------------------

const BLANK = /^[ \t]*$/;
const BLOCKQUOTE_MARKER = /^ {0,3}> ?/;
const FENCE_OPEN = /^(`{3,}|~{3,})/;
const ATX_HEADING = /^#{1,6}(?=[ \t]|$)/;
const SETEXT_UNDERLINE = /^(?:=+|-+)[ \t]*$/;
const THEMATIC_BREAK = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
/** GFM delimiter row; must also contain a pipe, or it is a setext underline or a thematic break. */
const TABLE_SEPARATOR_ROW = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const LIST_MARKER = /^(?:([-*+])|(\d{1,9})[.)])(?=[ \t]|$)/;
/** CommonMark HTML block type 6 (block-level tag names); may interrupt a paragraph. */
const HTML_BLOCK_TAG =
  /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]|\/?>|$)/i;
/**
 * CommonMark HTML block type 7: a tag alone on its line. Broader than the
 * spec's attribute grammar on purpose, so HTML lines stay literal text.
 */
const HTML_LONE_TAG = /^<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t][^<>]*)?\/?>[ \t]*$/;
/** CommonMark HTML block types 1-5 run to an end marker, across blank lines. */
const HTML_BLOCKS_WITH_END: Array<[start: RegExp, end: RegExp]> = [
  [/^<(?:script|pre|style|textarea)(?:[ \t>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  // Not a sanitizer, so CodeQL's `--!>` warning does not apply: this mirrors
  // CommonMark type 2 (ends on a line containing `-->`), as micromark in the
  // answer view reads it, and the view never hands raw HTML to the browser.
  // Ending at `--!>` would close the comment before the renderer does and
  // count citations still hidden inside it as visible. Keep it as is.
  [/^<!--/, /-->/],
  [/^<\?/, /\?>/],
  [/^<!\[CDATA\[/, /\]\]>/],
  [/^<![A-Za-z]/, />/]
];

type Container =
  | { type: "quote" }
  | { type: "item"; contentIndent: number; hasContent: boolean };

interface Block {
  /** "prose" splits into sentences; "row" (a table row, one line per rendered cell) stays whole. */
  kind: "prose" | "row";
  lines: string[];
  /**
   * False for code and HTML blocks: the renderer shows code as literal text
   * and drops HTML, so a citation marker there is never a clickable citation.
   */
  inline: boolean;
  /** Index of the first line whose citations never count (a paragraph that turned literal). */
  opaqueFrom?: number;
}

/** ASCII spaces only: CommonMark does not treat NBSP or other Unicode spaces as indentation. */
function leadingSpaces(value: string): number {
  return /^ */.exec(value)![0].length;
}

/** Tabs advance to the next multiple of four columns, as CommonMark counts indentation. */
function expandTabs(line: string): string {
  if (!line.includes("\t")) return line;
  let out = "";
  for (const character of line) {
    out += character === "\t" ? " ".repeat(4 - (out.length % 4)) : character;
  }
  return out;
}

/** The closing-fence pattern when `content` opens a fenced code block, else null. */
function fenceCloser(content: string): RegExp | null {
  const open = content.match(FENCE_OPEN)?.[1];
  if (!open) return null;
  // A backtick fence's info string cannot contain a backtick.
  if (open.startsWith("`") && content.slice(open.length).includes("`")) return null;
  return new RegExp(`^${open[0]}{${open.length},}[ \\t]*$`);
}

/**
 * Cells of a GFM table row. A pipe after a backslash escape (`\|`, also
 * inside code spans) is cell text; `\\|` is an escaped backslash and a
 * separator. One leading and one trailing separator are optional.
 */
function splitCells(row: string): string[] {
  const text = row.trim();
  const cells: string[] = [];
  let current = "";
  let endsWithSeparator = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    endsWithSeparator = false;
    if (character === "\\" && index + 1 < text.length) {
      current += character + text[index + 1];
      index++;
    } else if (character === "|") {
      cells.push(current);
      current = "";
      endsWithSeparator = true;
    } else {
      current += character;
    }
  }
  cells.push(current);
  if (text.startsWith("|")) cells.shift();
  if (endsWithSeparator && cells.length > 1) cells.pop();
  return cells.map((cell) => cell.trim());
}

/**
 * Splits the answer into leaf blocks the way a CommonMark/GFM renderer does.
 * Errs toward literal text: when a line could be read either way, a leading
 * number stays in the text, where it must be grounded.
 *
 * With `excerpt` set, text the renderer hides is kept, because an excerpt is
 * the source document: each ordered-list number and each fence info string
 * becomes a block of its own, and table rows keep cells past the header's
 * column count.
 */
function parseBlocks(answer: string, excerpt = false): Block[] {
  const blocks: Block[] = [];
  const stack: Container[] = [];
  let paragraph: Block | null = null;
  /**
   * Lines inside an HTML or indented-code block, or a paragraph that became
   * one: no structure is read from them. Indented code follows CommonMark;
   * HTML without an end marker runs to the next blank line whatever the
   * containers do.
   */
  let literal: Block | null = null;
  let literalEnd: RegExp | null = null;
  let literalIsCode = false;
  /**
   * Indented code can resume after blank lines, so micromark treats the next
   * unindented line in the same container as interrupting it: `    x\n\n2. y`
   * renders `2. y` as paragraph text. Tracked for any indented line, code or
   * not, so a misread block errs toward text.
   */
  let afterIndented = false;
  let fence: { closer: RegExp; block: Block } | null = null;
  let tableMode = false;
  /** Header column count of the open table; the renderer drops extra body cells. */
  let tableColumns = 0;

  const closeLeaves = () => {
    paragraph = null;
    literal = null;
    literalEnd = null;
    literalIsCode = false;
    tableMode = false;
  };
  const startProse = (text: string, inline = true): Block => {
    const block: Block = { kind: "prose", lines: [text], inline };
    blocks.push(block);
    return block;
  };
  const startCode = (text: string) => {
    literal = startProse(text, false);
    literalIsCode = true;
  };

  for (const rawLine of answer.split(/\r\n|\r|\n/)) {
    const line = expandTabs(rawLine);

    // Match open containers in order. A list item that is still empty does
    // not survive a blank line ("a list item can begin with at most one
    // blank line").
    let rest = line;
    let matched = 0;
    for (; matched < stack.length; matched++) {
      const container = stack[matched]!;
      if (container.type === "quote") {
        const marker = rest.match(BLOCKQUOTE_MARKER);
        if (!marker) break;
        rest = rest.slice(marker[0].length);
      } else if (BLANK.test(rest)) {
        if (!container.hasContent) break;
        rest = "";
      } else if (leadingSpaces(rest) >= container.contentIndent) {
        rest = rest.slice(container.contentIndent);
        container.hasContent = true;
      } else {
        break;
      }
    }
    const allMatched = matched === stack.length;
    const blank = BLANK.test(rest);
    const followsIndented = afterIndented && allMatched;
    if (!blank) afterIndented = leadingSpaces(rest) >= 4;
    else if (!allMatched) afterIndented = false;
    // A table ends with the container that holds it; tables take no lazy
    // continuation lines.
    if (!allMatched) tableMode = false;

    // A fenced code block ends at its closing fence or when its container ends.
    if (fence) {
      if (allMatched) {
        const indent = leadingSpaces(rest);
        if (indent <= 3 && fence.closer.test(rest.slice(indent))) fence = null;
        else fence.block.lines.push(rest);
        continue;
      }
      fence = null;
    }

    if (literal) {
      if (literalEnd) {
        if (allMatched) {
          (literal as Block).lines.push(rest);
          if ((literalEnd as RegExp).test(rest)) closeLeaves();
          continue;
        }
        closeLeaves();
      } else if (literalIsCode) {
        // Indented code continues on lines indented four more columns.
        if (allMatched && !blank && leadingSpaces(rest) >= 4) {
          (literal as Block).lines.push(rest);
          continue;
        }
        closeLeaves();
      } else if (!blank) {
        // The renderer closed any container this line does not match.
        stack.length = matched;
        (literal as Block).lines.push(rest);
        // If the renderer ended the HTML block earlier, this line may open a
        // fence or a comment that runs past blank lines. Assume it does: the
        // lines stay literal either way.
        const opener = rest.slice(leadingSpaces(rest));
        const closer = fenceCloser(opener);
        const end = HTML_BLOCKS_WITH_END.find(([start]) => start.test(opener))?.[1];
        if (closer) {
          const block = literal as Block;
          closeLeaves();
          fence = { closer, block };
        } else if (end && !end.test(opener)) {
          literalEnd = end;
        }
        continue;
      }
    }

    if (blank) {
      stack.length = matched;
      closeLeaves();
      continue;
    }

    // Whether a block start on this line interrupts a paragraph (or indented
    // code). As in micromark, this carries into containers opened on the same
    // line, so `p\n> 99. x` keeps `99.` as paragraph text. A table body counts
    // too, on purpose and only outside new containers: if the table detection
    // is wrong, the lines are paragraph text, and a list right under a real
    // table needs `1.` or a blank line first.
    const inParagraph = allMatched && paragraph !== null;
    const sticky = inParagraph || followsIndented;
    let interrupting = sticky || tableMode;
    let opened = false;
    const openContainers = () => {
      if (!opened) {
        stack.length = matched;
        opened = true;
      }
    };

    for (;;) {
      const indent = leadingSpaces(rest);
      if (indent >= 4) {
        // Indented code cannot interrupt a paragraph: the line continues it.
        if (paragraph) {
          (paragraph as Block).lines.push(rest);
        } else {
          openContainers();
          closeLeaves();
          startCode(rest);
        }
        break;
      }
      const content = rest.slice(indent);

      if (content.startsWith(">")) {
        openContainers();
        closeLeaves();
        stack.push({ type: "quote" });
        interrupting = sticky;
        matched = stack.length;
        rest = content.slice(content.startsWith("> ") ? 2 : 1);
        if (BLANK.test(rest)) break;
        continue;
      }

      const closer = fenceCloser(content);
      if (closer) {
        openContainers();
        closeLeaves();
        // The info string is not displayed; the code lines are.
        const info = content.replace(FENCE_OPEN, "").trim();
        if (excerpt && info) blocks.push({ kind: "prose", lines: [info], inline: false });
        const block: Block = { kind: "prose", lines: [], inline: false };
        blocks.push(block);
        fence = { closer, block };
        break;
      }

      if (ATX_HEADING.test(content)) {
        openContainers();
        closeLeaves();
        startProse(content.replace(/^#{1,6}/, "").replace(/[ \t]+#+[ \t]*$/, ""));
        break;
      }

      if (inParagraph && paragraph !== null && SETEXT_UNDERLINE.test(content)) {
        closeLeaves();
        break;
      }

      if (THEMATIC_BREAK.test(content)) {
        openContainers();
        closeLeaves();
        break;
      }

      const open = paragraph as Block | null;
      const headerRow = open?.lines[open.lines.length - 1];
      if (
        inParagraph &&
        open !== null &&
        headerRow !== undefined &&
        /[^|\s]/.test(headerRow) &&
        leadingSpaces(headerRow) < 4 &&
        content.includes("|") &&
        TABLE_SEPARATOR_ROW.test(content) &&
        splitCells(headerRow).length === splitCells(content).length
      ) {
        // The paragraph's last line is the header row; it becomes its own row.
        open.lines.pop();
        if (open.lines.length === 0) blocks.splice(blocks.indexOf(open), 1);
        const header = splitCells(headerRow);
        blocks.push({ kind: "row", lines: header, inline: true });
        paragraph = null;
        tableMode = true;
        tableColumns = header.length;
        break;
      }

      const marker = content.match(LIST_MARKER);
      if (marker) {
        const afterMarker = content.slice(marker[0].length);
        const emptyItem = BLANK.test(afterMarker);
        const ordinal = marker[2];
        // Only a non-empty bullet or `1.`/`1)` item may interrupt (micromark
        // rejects `01.` there too).
        const canStart =
          !interrupting || (!emptyItem && (ordinal === undefined || ordinal === "1"));
        if (canStart) {
          openContainers();
          closeLeaves();
          if (excerpt && ordinal !== undefined) {
            blocks.push({ kind: "prose", lines: [ordinal], inline: false });
          }
          const spaces = emptyItem ? 1 : leadingSpaces(afterMarker);
          const contentIndent = indent + marker[0].length + (spaces >= 5 ? 1 : spaces);
          stack.push({ type: "item", contentIndent, hasContent: !emptyItem });
          interrupting = sticky;
          matched = stack.length;
          if (emptyItem) break;
          if (spaces >= 5) {
            // Item content that starts with an indented code block.
            startCode(afterMarker);
            break;
          }
          rest = afterMarker.slice(spaces);
          continue;
        }
      }

      // HTML types 1-6 start a new block, even mid-paragraph. Type 7 cannot
      // interrupt a paragraph; there the paragraph turns literal instead.
      // Its later lines may be paragraph text, HTML or code to the renderer,
      // so citations on them do not count.
      const withEnd = HTML_BLOCKS_WITH_END.find(([start]) => start.test(content));
      if (withEnd || HTML_BLOCK_TAG.test(content) || HTML_LONE_TAG.test(content)) {
        if (!withEnd && !HTML_BLOCK_TAG.test(content) && paragraph) {
          (paragraph as Block).lines.push(content);
          (paragraph as Block).opaqueFrom = (paragraph as Block).lines.length;
          literal = paragraph;
          break;
        }
        openContainers();
        closeLeaves();
        literal = startProse(content, false);
        const end = withEnd?.[1] ?? null;
        if (end?.test(content)) closeLeaves();
        else literalEnd = end;
        break;
      }

      // GFM table body rows run until a blank line or another block start. A
      // pipe line outside a table is paragraph text. Cells beyond the header's
      // column count are not rendered: their figures and citations are invisible.
      if (tableMode) {
        openContainers();
        const cells = splitCells(content);
        blocks.push({ kind: "row", lines: excerpt ? cells : cells.slice(0, tableColumns), inline: true });
        break;
      }

      // Paragraph text: continuation (including lazy continuation) or a new paragraph.
      if (paragraph) {
        (paragraph as Block).lines.push(content);
      } else {
        openContainers();
        closeLeaves();
        paragraph = startProse(content);
      }
      break;
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Visible citations
// ---------------------------------------------------------------------------

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
/** CommonMark autolink (`<scheme:...>`): rendered as a plain link, never a citation. */
const AUTOLINK = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\x00-\x20<>]*>/y;
/**
 * Spans that may or may not swallow what follows, depending on rules the
 * gate does not model (see `hideInvisibleCitations`): a GFM autolink literal
 * (remark-gfm), which depends on the character before it, the domain, and
 * open link labels; and a link with empty text, `[](...)`, whose
 * destination may hold a citation link. `[]` is the one bracket pair the
 * answer view's rewrite leaves alone.
 */
const OPTIONAL_SPAN_START = /https?:\/\/|www\.|\[\]\(/gi;
/** Readings are enumerated up to this many optional spans; past it, no citation in the block counts. */
const MAX_OPTIONAL_SPANS = 4;
/** CommonMark inline raw HTML; the answer view shows it as literal text, never as a link. */
const INLINE_HTML = new RegExp(
  [
    "<!--(?:-?>|[\\s\\S]*?-->)",
    "<\\?[\\s\\S]*?\\?>",
    "<![A-Za-z][^>]*>",
    "<!\\[CDATA\\[[\\s\\S]*?\\]\\]>",
    "<\\/[A-Za-z][A-Za-z0-9-]*[ \\t\\n]*>",
    "<[A-Za-z][A-Za-z0-9-]*(?:[ \\t\\n]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \\t\\n]*=[ \\t\\n]*(?:[^ \\t\\n\"'=<>`]+|'[^']*'|\"[^\"]*\"))?)*[ \\t\\n]*\\/?>"
  ].join("|"),
  "y"
);

function backtickRun(text: string, from: number): number {
  let end = from;
  while (text[end] === "`") end++;
  return end - from;
}

/**
 * End of the optional span starting at `from`, taken as a link.
 *
 * - GFM autolink literal: the next whitespace or `<`, or a `]` followed by
 *   `(`, `[`, whitespace or the end. A citation sentinel stands for
 *   `[N](#cite:id)`, so the literal takes its `[N` and ends there.
 * - `[](`: the `)` that balances the `(`; the end of the text when none does.
 */
function optionalSpanEnd(text: string, from: number): number {
  if (text[from] === "[") {
    let depth = 0;
    for (let index = from + 2; index < text.length; index++) {
      const character = text[index]!;
      if (character === "\\") index++;
      else if (character === "(") depth++;
      else if (character === ")" && --depth === 0) return index + 1;
    }
    return text.length;
  }
  for (let index = from; index < text.length; index++) {
    const character = text[index]!;
    if (/\s/.test(character) || character === "<") return index;
    if (SENTINEL.test(character)) return index + 1;
    const after = text[index + 1] ?? "";
    if (character === "]" && (after === "" || /[([\s]/.test(after) || SENTINEL.test(after))) {
      return index;
    }
  }
  return text.length;
}

/**
 * Indexes of the citation sentinels the CSR cannot click under one reading
 * of the inline content, where `taken` maps the optional spans read as links
 * to their ends. Scanned left to right as micromark does, so the construct
 * that opens first wins.
 */
function invisibleCitations(text: string, taken: ReadonlyMap<number, number>): Set<number> {
  const hidden = new Set<number>();
  const hideRange = (from: number, to: number) => {
    for (let index = from; index < to; index++) {
      if (SENTINEL.test(text[index]!)) hidden.add(index);
    }
  };
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    const next = text[index + 1] ?? "";
    const spanEnd = taken.get(index);
    if (spanEnd !== undefined) {
      hideRange(index, spanEnd);
      index = Math.max(spanEnd, index + 1);
    } else if (character === "\\") {
      if (ASCII_PUNCTUATION.test(next) || SENTINEL.test(next)) {
        hideRange(index + 1, index + 2);
        index += 2;
      } else {
        index++;
      }
    } else if (character === "`") {
      const run = backtickRun(text, index);
      // A code span closes at the next backtick run of the same length.
      let close = -1;
      for (let at = index + run; at < text.length; ) {
        if (text[at] !== "`") {
          at++;
          continue;
        }
        const length = backtickRun(text, at);
        if (length === run) {
          close = at;
          break;
        }
        at += length;
      }
      if (close >= 0) {
        hideRange(index, close + run);
        index = close + run;
      } else {
        index += run;
      }
    } else if (character === "<") {
      AUTOLINK.lastIndex = index;
      INLINE_HTML.lastIndex = index;
      const tag = AUTOLINK.exec(text) ?? INLINE_HTML.exec(text);
      if (tag) {
        hideRange(index, index + tag[0].length);
        index += tag[0].length;
      } else {
        index++;
      }
    } else if (character === "!" && SENTINEL.test(next)) {
      hideRange(index + 1, index + 2);
      index += 2;
    } else {
      index++;
    }
  }
  return hidden;
}

/**
 * Inline content with every citation the CSR cannot click replaced by a
 * space. A citation sentinel stands for the `[N](#cite:id)` link the answer
 * view writes; it is not a link inside a code span, raw HTML (shown as
 * text), an autolink, a GFM autolink literal or another link's destination,
 * after a backslash (`\[`), or after `!` (an image). An optional span also
 * swallows backticks and backslashes, which changes what follows, so every
 * combination of optional spans is read and a citation counts only if it is
 * visible in all of them.
 */
function hideInvisibleCitations(text: string): string {
  const starts = [...text.matchAll(OPTIONAL_SPAN_START)].map((match) => match.index);
  if (starts.length > MAX_OPTIONAL_SPANS) return text.replace(SENTINEL_ALL, " ");
  const ends = starts.map((start) => optionalSpanEnd(text, start));
  const hidden = new Set<number>();
  for (let mask = 0; mask < 1 << starts.length; mask++) {
    const taken = new Map<number, number>();
    starts.forEach((start, bit) => {
      if ((mask >> bit) & 1) taken.set(start, ends[bit]!);
    });
    for (const at of invisibleCitations(text, taken)) hidden.add(at);
  }
  if (hidden.size === 0) return text;
  const characters = text.split("");
  for (const at of hidden) characters[at] = " ";
  return characters.join("");
}

// ---------------------------------------------------------------------------
// Displayed text
// ---------------------------------------------------------------------------

/**
 * Character references the renderer decodes that matter for figures. Any
 * other named reference in an answer is treated as unverifiable.
 */
const NAMED_REFERENCES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  nbsp: "\u00a0", NonBreakingSpace: "\u00a0", ensp: "\u2002", emsp: "\u2003",
  emsp13: "\u2004", emsp14: "\u2005", numsp: "\u2007", puncsp: "\u2008",
  thinsp: "\u2009", ThinSpace: "\u2009", hairsp: "\u200a", VeryThinSpace: "\u200a",
  MediumSpace: "\u205f", Tab: "\t", NewLine: "\n",
  shy: "\u00ad", zwj: "\u200d", zwnj: "\u200c", lrm: "\u200e", rlm: "\u200f",
  ZeroWidthSpace: "\u200b", NegativeVeryThinSpace: "\u200b", NegativeThinSpace: "\u200b",
  NegativeMediumSpace: "\u200b", NegativeThickSpace: "\u200b", NoBreak: "\u2060",
  ApplyFunction: "\u2061", af: "\u2061", InvisibleTimes: "\u2062", it: "\u2062",
  InvisibleComma: "\u2063", ic: "\u2063",
  dollar: "$", cent: "¢", pound: "£", yen: "¥", euro: "€",
  curren: "¤", percnt: "%", permil: "‰", period: ".", comma: ",",
  colon: ":", semi: ";", sol: "/", bsol: "\\", num: "#", plus: "+", equals: "=",
  hyphen: "\u2010", dash: "\u2010", ndash: "\u2013", mdash: "\u2014", minus: "\u2212",
  ast: "*", midast: "*", lowbar: "_", UnderBar: "_", grave: "`", DiacriticalGrave: "`",
  sup1: "¹", sup2: "²", sup3: "³", frac12: "½", half: "½",
  frac14: "¼", frac34: "¾", deg: "°", times: "×", divide: "÷",
  middot: "·", centerdot: "·"
};
const ESCAPE_OR_REFERENCE =
  /\\([!-/:-@[-`{-~])|&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{0,31}));/g;
const NUMERIC_CHARACTER = /\p{N}/gu;
const ASCII_DIGIT = /[0-9]/;
/** Invisible or non-rendering: format, control, unassigned, surrogate, and combining marks. */
const INVISIBLE = /[\p{Cf}\p{Cc}\p{Cn}\p{Cs}\p{M}]/gu;
const WHITESPACE_CONTROL = /[\t\n\v\f\r\u0085]/g;
const SPACES = /[\s\p{Z}]+/gu;
const DASHES = /[\p{Pd}\u2212]/gu;
const INLINE_MARKUP = /[*_~`]/g;
/** `5 009` (thousands grouped by a space) reads as one number. */
const SPACE_GROUPED_NUMBER = /(?<![\p{L}\p{N}])\d{1,3}(?: \d{3})+(?![\p{L}\p{N}\/⁄∕])/gu;
/**
 * Where a decimal digit meets a vulgar fraction, superscript or other
 * `\p{No}` numeral (`4½`, `4¹/₂`, `10²`). NFKC turns `½` into `1⁄2`
 * (U+2044) and `²` into `2`, which would run into the digit (`41⁄2`,
 * `102`); a space keeps them apart, so `4½` and `4 1⁄2` read the same.
 */
const DIGIT_STYLE_CHANGE = /(?<=\p{Nd})(?=\p{No})|(?<=\p{No})(?=\p{Nd})/gu;

interface DisplayText {
  text: string;
  /** Set when the text holds something the gate cannot read as the CSR would. */
  unverifiable: string | null;
}

/**
 * Two readings of the same Markdown, and a figure must be grounded in both.
 * The renderer decodes escapes and character references in prose but not in
 * code or HTML, and `5*0*` displays as `50` while `5````0` displays as is.
 * Rather than model each case, the gate checks the decoded text with markup
 * removed and the raw text with markup as a separator.
 */
interface View {
  decode: boolean;
  markup: "" | " ";
}
const VIEWS: readonly View[] = [
  { decode: true, markup: "" },
  { decode: false, markup: " " }
];

/**
 * The text a reader sees under one view. `strict` (answers) rejects numeric
 * characters NFKC cannot map to ASCII digits and unknown named character
 * references.
 */
function displayText(value: string, view: View, strict: boolean): DisplayText {
  let unverifiable: string | null = null;
  let text = !view.decode ? value : value.replace(
    ESCAPE_OR_REFERENCE,
    (original, escaped: string | undefined, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (escaped !== undefined) return escaped;
      if (name !== undefined) {
        const decoded = NAMED_REFERENCES[name];
        if (decoded === undefined) {
          if (strict) unverifiable ??= original;
          return original;
        }
        return decoded;
      }
      const codePoint = Number.parseInt(decimal ?? hex ?? "", decimal !== undefined ? 10 : 16);
      if (
        codePoint === 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
        (codePoint >= SENTINEL_BASE && codePoint <= SENTINEL_LIMIT)
      ) {
        return "\ufffd";
      }
      return String.fromCodePoint(codePoint);
    }
  );

  if (strict) {
    for (const [character] of text.matchAll(NUMERIC_CHARACTER)) {
      if (!ASCII_DIGIT.test(character.normalize("NFKC"))) {
        unverifiable ??= character;
      }
    }
  }

  text = text
    .replace(DIGIT_STYLE_CHANGE, " ")
    .normalize("NFKC")
    .replace(WHITESPACE_CONTROL, " ")
    .replace(INVISIBLE, "")
    .replace(INLINE_MARKUP, view.markup)
    .replace(SPACES, " ")
    .replace(DASHES, "-")
    .replace(SPACE_GROUPED_NUMBER, (number) => number.replace(/ /g, ""));
  return { text, unverifiable };
}

// ---------------------------------------------------------------------------
// Sentences and citation groups
// ---------------------------------------------------------------------------

/**
 * Sentence end: terminal punctuation, optional closers, then optional
 * citation groups (with or without whitespace before them), then whitespace
 * or the end. A citation after the period belongs to the sentence before it.
 */
const SENTENCE_END = /[.!?]["'”’)\]]*(?:[\s,;]*[\ue000-\uf8ff])*(?=\s|$)/g;
const ABBREVIATION_BEFORE_PERIOD =
  /(?:^|[^\p{L}\p{N}])(?:no|nos|num|vol|sec|art|ch|pg|pp?|para|ref|ext|approx|est|min|max|rev|ver|vs|fig|ste|apt|tel|incl)$/iu;
const DIGIT_AHEAD = /^\s+\p{Sc}?\d/u;
/** `e.g.` and `i.e.` introduce an example or a restatement: the sentence goes on whatever follows. */
const EXPLANATORY_ABBREVIATION_BEFORE_PERIOD = /(?:^|[^\p{L}\p{N}])(?:e\.g|i\.e)$/iu;
/** Dotted time abbreviation (`a.m.`, `P.M.`) whose final period was matched. */
const TIME_ABBREVIATION_BEFORE_PERIOD = /(?:^|[^\p{L}\p{N}])[ap]\.m$/iu;
/** After `a.m.`/`p.m.` the sentence ends only when an uppercase letter starts the next one. */
const UPPERCASE_AHEAD = /^\s+[\p{Lu}\p{Lt}]/u;
/** A sentence holding nothing but citations and punctuation joins the sentence before it. */
const CITATION_ONLY_REMAINDER = /^[\s.,;:!?()[\]"'“”‘’-]*$/;

interface CitationGroup {
  start: number;
  end: number;
  ids: string[];
}

interface Sentence {
  text: string;
  /** `text` with the citation placeholders still in place (same length). */
  marked: string;
  groups: CitationGroup[];
}

function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length;
    if (match[0] === ".") {
      const before = text.slice(start, match.index);
      const after = text.slice(end);
      if (EXPLANATORY_ABBREVIATION_BEFORE_PERIOD.test(before)) continue;
      if (ABBREVIATION_BEFORE_PERIOD.test(before) && DIGIT_AHEAD.test(after)) continue;
      if (TIME_ABBREVIATION_BEFORE_PERIOD.test(before) && !UPPERCASE_AHEAD.test(after)) {
        continue;
      }
    }
    sentences.push(text.slice(start, end));
    start = end;
  }
  sentences.push(text.slice(start));
  return sentences.filter((sentence) => sentence.trim().length > 0);
}

function readSentence(raw: string, sentinelIds: string[]): Sentence {
  const groups: CitationGroup[] = [];
  for (const match of raw.matchAll(SENTINEL_GROUP)) {
    const ids: string[] = [];
    for (const character of match[0]) {
      if (!SENTINEL.test(character)) continue;
      const id = sentinelIds[character.charCodeAt(0) - SENTINEL_BASE];
      if (id !== undefined && !ids.includes(id)) ids.push(id);
    }
    groups.push({ start: match.index, end: match.index + match[0].length, ids });
  }
  // Same length as `raw`, so group offsets stay valid.
  const text = raw.replace(/[\ue000-\uf8ff]/g, " ");
  return { text, marked: raw, groups };
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

type FigureKind = "plain" | "currency" | "percent" | "compound";

interface Figure {
  kind: FigureKind;
  /** Exact comparison key, kind and unit included. */
  key: string;
  /** Plain-number key of a number joined to a unit word (`30-day`, `50GB`), which also matches `30 days`. */
  alt?: string;
  text: string;
  start: number;
  end: number;
}

/**
 * Letters and digits joined by `-`, `/`, `:`, `.`, `,` or a fraction slash
 * (U+2044, U+2215); a leading `.` only before a digit. A digit, one space
 * and a fraction (`4 1⁄2`, `4 1/2`) stay one figure.
 */
const FIGURE_TOKEN =
  /(?:(?<![\p{L}\p{N}.])\.(?=\d))?[\p{L}\p{N}]+(?:(?:[-/:.,⁄∕]|(?<=\d) (?=\d+[/⁄∕]\d))[\p{L}\p{N}]+)*/gu;
const FRACTION_SLASH = /[⁄∕]/g;
const NUMBER = /^(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)$/;
const CURRENCY_CODES =
  "USD|EUR|GBP|CAD|AUD|NZD|JPY|CNY|INR|MXN|CHF|SEK|NOK|DKK|ZAR|BRL|HKD|SGD|PHP";
/**
 * Signs after display normalization: ASCII `-` and `+` (every `\p{Pd}`, U+2212
 * and NFKC's minus and plus forms already read as these), plus the minus and
 * plus forms NFKC leaves (U+02D6, U+02D7, U+2052, U+2795, U+2796).
 */
const MINUS_SIGNS = "\\-\u02d7\u2052\u2796";
const SIGNS = `${MINUS_SIGNS}+\u02d6\u2795`;
const MINUS = new RegExp(`^[${MINUS_SIGNS}]$`, "u");
/**
 * A currency symbol or code before the number, with an optional sign between
 * it and the digits (`$-40`, `USD -40`); group 3 is the sign, group 4 any
 * space between the sign and the digits.
 */
const CURRENCY_BEFORE = new RegExp(
  `(?:(\\p{Sc})|(?<![\\p{L}\\p{N}])(${CURRENCY_CODES}))(?: ?([${SIGNS}])( ?)| ?)$`,
  "u"
);
const CURRENCY_AFTER = new RegExp(`^ ?(?:(\\p{Sc})|(${CURRENCY_CODES})(?![\\p{L}\\p{N}]))`, "u");
/**
 * A money word after the number makes it currency in that unit, with one
 * capitalized qualifier kept as part of the unit: `40 cents` is not `$40`,
 * and `40 US dollars` is not `40 Canadian dollars`.
 */
const QUALIFIED_WORD_AFTER = /^ +(\p{Lu}[\p{L}.]*) +(\p{L}+)(?![\p{L}\p{N}])/u;
const WORD_AFTER = /^ +()(\p{L}+)(?![\p{L}\p{N}])/u;
const MONEY_WORD =
  /^(?:dollars?|cents?|euros?|pounds?|pence|yen|yuan|rupees?|pesos?|francs?|bucks?|quid|rand|grand)$/i;
/** A scale word is part of the value: `$40 million` is `$40000000`. */
const SCALE_WORD_AFTER = /^ +(hundred|thousand|lakh|million|crore|billion|trillion)(?![\p{L}\p{N}])/iu;
/** Scale letters attached to a currency amount (`$40k`, `$2.5M`), or set apart by one space (`$40 M`). */
const ATTACHED_SCALE = /^(.*\d)(k|m|mm|mn|b|bn|t|tn)$/i;
const SPACED_SCALE_AFTER = /^ (K|M|MM|B|BN|Bn|bn|mn)(?![\p{L}\p{N}])/u;
const SCALE_EXPONENTS: Record<string, number> = {
  hundred: 2, thousand: 3, lakh: 5, million: 6, crore: 7, billion: 9, trillion: 12,
  k: 3, m: 6, mm: 6, mn: 6, b: 9, bn: 9, t: 12, tn: 12
};
/**
 * A number joined to a unit word by a hyphen (`30-day`, `2-business-day`) or
 * written against a word of two or more letters (`50GB`, `2FA`). Group 2 is
 * the first word, so a scale letter (`10k`, `40-M`) is not read as a unit.
 */
const NUMBER_WITH_UNIT_WORD = /^(\d+(?:\.\d+)?)(?:-|(?=\p{L}{2,}$))(\p{L}+)(?:-\p{L}+)*$/u;
const PERCENT_AFTER = /^(?: ?[%‰]| (?:percent|per cent|pct)(?![\p{L}\p{N}]))/iu;
const SIGN_BEFORE = new RegExp(`(?<![\\p{L}\\p{N}])[${MINUS_SIGNS}]$`, "u");
const ANY_SIGN_BEFORE = new RegExp(`(?<![\\p{L}\\p{N}])[${SIGNS}]$`, "u");

function canonicalNumber(token: string): string {
  let digits = token.replace(/,/g, "");
  if (digits.startsWith(".")) digits = `0${digits}`;
  if (digits.includes(".")) digits = digits.replace(/0+$/, "").replace(/\.$/, "");
  return digits;
}

/** Shifts the decimal point of a canonical number `exponent` places right, as strings. */
function scaleNumber(canonical: string, exponent: number): string {
  if (exponent === 0) return canonical;
  const [whole, fraction = ""] = canonical.split(".");
  const padded = fraction.padEnd(exponent, "0");
  const integer = `${whole}${padded.slice(0, exponent)}`.replace(/^0+(?=\d)/, "");
  const rest = padded.slice(exponent).replace(/0+$/, "");
  return rest ? `${integer}.${rest}` : integer;
}

/** Singular, lowercase money word with its qualifier: `US Dollars` reads as `us dollar`. */
function currencyWord(qualifier: string, word: string): string {
  const lower = word.toLowerCase();
  const singular = lower === "pence" ? lower : lower.replace(/s$/, "");
  const prefix = qualifier.trim().toLowerCase().replace(/\./g, "");
  return prefix ? `${prefix} ${singular}` : singular;
}

/**
 * A citation group and the spaces around it, read as one space when typing a
 * figure, so `25 [S1] percent` and `$25 [S1] M` take the unit and scale that
 * `25 percent` and `$25 M` do.
 */
const CITATION_IN_WINDOW = /\s*[\ue000-\uf8ff](?:[\s,;]*[\ue000-\uf8ff])*\s*/g;

/**
 * `marked` with each citation group collapsed to one space, and the offset in
 * the collapsed string of every offset in `marked` (one more entry than
 * `marked` has characters). An offset inside a group maps to its space.
 */
function collapseCitations(marked: string): { collapsed: string; offsets: Int32Array } {
  const offsets = new Int32Array(marked.length + 1);
  let collapsed = "";
  let from = 0;
  for (const match of marked.matchAll(CITATION_IN_WINDOW)) {
    for (let i = from; i < match.index; i++) offsets[i] = collapsed.length + (i - from);
    collapsed += marked.slice(from, match.index);
    for (let i = match.index; i < match.index + match[0].length; i++) offsets[i] = collapsed.length;
    collapsed += " ";
    from = match.index + match[0].length;
  }
  for (let i = from; i <= marked.length; i++) offsets[i] = collapsed.length + (i - from);
  collapsed += marked.slice(from);
  return { collapsed, offsets };
}

/**
 * `marked` is `text` with citation placeholders still in place (same length).
 * Figures and their offsets come from `text`; units, scales and signs are read
 * from `marked` with the citations collapsed, and the window sizes count
 * characters after that collapse.
 */
function extractFigures(text: string, marked: string = text): Figure[] {
  const figures: Figure[] = [];
  const { collapsed, offsets } = collapseCitations(marked);
  for (const match of text.matchAll(FIGURE_TOKEN)) {
    const token = match[0];
    if (!ASCII_DIGIT.test(token)) continue;
    const start = match.index;
    const end = start + token.length;
    // Units and signs sit within a few characters of the number. A citation
    // never touches a token character, so `start` and `end` map exactly.
    const collapsedStart = offsets[start]!;
    const collapsedEnd = offsets[end]!;
    const beforeWindow = collapsed.slice(Math.max(0, collapsedStart - 16), collapsedStart);
    const afterWindow = collapsed.slice(collapsedEnd, collapsedEnd + 40);
    let before = beforeWindow;
    let after = afterWindow;
    let consumed = 0;
    const take = (matched: RegExpExecArray | null): RegExpExecArray | null => {
      if (matched) {
        after = after.slice(matched[0].length);
        consumed += matched[0].length;
      }
      return matched;
    };

    const currencyBefore = before.match(CURRENCY_BEFORE);
    if (currencyBefore) before = before.slice(0, before.length - currencyBefore[0].length);
    const scaleWord = take(SCALE_WORD_AFTER.exec(after));
    const currencyAfter = currencyBefore ? null : take(CURRENCY_AFTER.exec(after));
    const money = (word: RegExpExecArray | null) => (word && MONEY_WORD.test(word[2]!) ? word : null);
    const moneyWord = currencyAfter
      ? null
      : take(money(QUALIFIED_WORD_AFTER.exec(after)) ?? money(WORD_AFTER.exec(after)));
    const symbol = currencyBefore
      ? (currencyBefore[1] ?? currencyBefore[2]!)
      : currencyAfter
        ? (currencyAfter[1] ?? currencyAfter[2]!)
        : null;
    const units = [symbol, moneyWord ? currencyWord(moneyWord[1]!, moneyWord[2]!) : null].filter(
      (unit): unit is string => unit !== null
    );
    const unit = units.length > 0 ? units.join("+") : null;

    let base = token;
    let exponent = scaleWord ? SCALE_EXPONENTS[scaleWord[1]!.toLowerCase()]! : 0;
    const attached = unit && !scaleWord ? ATTACHED_SCALE.exec(token) : null;
    if (attached && NUMBER.test(attached[1]!)) {
      base = attached[1]!;
      exponent = SCALE_EXPONENTS[attached[2]!.toLowerCase()]!;
    } else if (unit && !scaleWord && NUMBER.test(token)) {
      const spaced = take(SPACED_SCALE_AFTER.exec(after));
      if (spaced) exponent = SCALE_EXPONENTS[spaced[1]!.toLowerCase()]!;
    }

    const percent = take(PERCENT_AFTER.exec(after));
    const percentMark = percent ? (percent[0].includes("‰") ? "‰" : "%") : "";
    const leadingMinus = SIGN_BEFORE.test(before);
    const innerSign = currencyBefore?.[3];
    // `-$40`, `$-40` and `USD -40` are all minus 40 in that unit, and `$+40`
    // is 40. Two signs (`-$-40`, `+$-40`) or a sign set apart from the digits
    // (`$ - 40`) is ambiguous: such a figure matches only the same text.
    const twoSigns = innerSign !== undefined && ANY_SIGN_BEFORE.test(before);
    const ambiguousSign = twoSigns || (innerSign !== undefined && currencyBefore![4] !== "");
    const sign = leadingMinus || (innerSign !== undefined && MINUS.test(innerSign)) ? "-" : "";
    const prefixLength = (currencyBefore?.[0].length ?? 0) + (leadingMinus || twoSigns ? 1 : 0);
    const figureText = (
      beforeWindow.slice(beforeWindow.length - prefixLength) +
      token +
      afterWindow.slice(0, consumed)
    ).trim();

    if (ambiguousSign) {
      figures.push({ kind: "compound", key: `ambiguous:${figureText}`, text: figureText, start, end });
    } else if (NUMBER.test(base) && !(unit && percent)) {
      const number = `${sign}${scaleNumber(canonicalNumber(base), exponent)}`;
      const kind: FigureKind = unit ? "currency" : percent ? "percent" : "plain";
      const key =
        kind === "currency" ? `currency:${unit}:${number}` : kind === "percent" ? `percent:${percentMark}:${number}` : `plain:${number}`;
      figures.push({ kind, key, text: figureText, start, end });
    } else {
      const scale = exponent > 0 ? `e${exponent}` : "";
      const compound = token.toLowerCase().replace(FRACTION_SLASH, "/");
      const key = `compound:${sign}${unit ?? ""}${compound}${scale}${percentMark}`;
      const unitWord = !unit && !scale && !percentMark && !sign ? NUMBER_WITH_UNIT_WORD.exec(token) : null;
      const alt =
        unitWord && !(unitWord[2]!.toLowerCase() in SCALE_EXPONENTS)
          ? `plain:${canonicalNumber(unitWord[1]!)}`
          : undefined;
      figures.push({ kind: "compound", key, alt, text: figureText, start, end });
    }
  }
  return figures;
}

/** CommonMark backslash escape: a backslash before any ASCII punctuation character. */
const MARKDOWN_ESCAPE = /\\([!-/:-@[-`{-~])/g;

/**
 * Document conversion stores excerpts with Markdown escapes (`RF\-01`,
 * `5\-7`, `\$25`). Both excerpt readings decode them, so the backslash never
 * splits or changes a figure; decoding adds no digit the document lacks.
 * Answers keep their two readings as is.
 *
 * Figures are read per block (paragraph, list item, heading, table row, code
 * or HTML block), split as `parseBlocks` splits answers, so a unit, scale,
 * sign or digit group never attaches across a block boundary:
 * `Fee: $40\n\nMillion customers` holds `$40`, not `$40 million`. Lines of
 * one paragraph still read as one text, so `$40\nmillion` is `$40 million`.
 */
function indexExcerpt(content: string, view: View): Set<string> {
  const keys = new Set<string>();
  for (const block of parseBlocks(content.replace(PRIVATE_USE, ""), true)) {
    let source = block.lines.join(block.kind === "row" ? " | " : "\n");
    if (!view.decode) source = source.replace(MARKDOWN_ESCAPE, "$1");
    const { text } = displayText(source, view, false);
    for (const figure of extractFigures(text)) {
      keys.add(figure.key);
      if (figure.alt) keys.add(figure.alt);
    }
  }
  return keys;
}

/**
 * Same kind, unit and value: a plain number matches only a plain number. A
 * number joined to a unit word also reads as that plain number, so `30 days`
 * and `30-day` ground each other.
 */
function excerptHasFigure(excerpt: Set<string>, figure: Figure): boolean {
  return excerpt.has(figure.key) || (figure.alt !== undefined && excerpt.has(figure.alt));
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/**
 * Returns the first figure not grounded in an excerpt its own claim cites (or
 * the text that makes the answer unverifiable), else null. `question` is the
 * CSR's own wording; a figure it holds needs no excerpt.
 */
export function findUngroundedFigure(
  normalizedAnswer: string,
  chunks: RetrievalChunk[],
  question?: string
): string | null {
  const contentById = new Map(chunks.map((chunk) => [chunk.id, chunk.content]));
  const sentinelIds: string[] = [];
  const sentinelById = new Map<string, string>();
  // The answer view's rewrite (annotateCitations): a known id becomes a
  // citation link, anything else in brackets a non-clickable link whose label
  // escapes `\`, `[` and `]`.
  const answer = normalizedAnswer.replace(PRIVATE_USE, "").replace(
    CITATION_MARKER,
    (original, id: string) => {
      if (!contentById.has(id)) return `[${original.replace(/([\\[\]])/g, "\\$1")}](#cite-unknown)`;
      let sentinel = sentinelById.get(id);
      if (sentinel === undefined) {
        if (SENTINEL_BASE + sentinelIds.length > SENTINEL_LIMIT) return original;
        sentinel = String.fromCharCode(SENTINEL_BASE + sentinelIds.length);
        sentinelIds.push(id);
        sentinelById.set(id, sentinel);
      }
      return sentinel;
    }
  );
  const blocks = parseBlocks(answer).map((block) => {
    const text = block.lines.join(block.kind === "row" ? " | " : "\n");
    if (!block.inline) return { kind: block.kind, content: text.replace(SENTINEL_ALL, " ") };
    if (block.kind === "row") {
      return { kind: block.kind, content: block.lines.map(hideInvisibleCitations).join(" | ") };
    }
    const visible = hideInvisibleCitations(text);
    if (block.opaqueFrom === undefined) return { kind: block.kind, content: visible };
    const cut = block.lines.slice(0, block.opaqueFrom).join("\n").length;
    return {
      kind: block.kind,
      content: visible.slice(0, cut) + visible.slice(cut).replace(SENTINEL_ALL, " ")
    };
  });

  for (const view of VIEWS) {
    const sentences: Sentence[] = [];
    for (const block of blocks) {
      const display = displayText(block.content, view, true);
      if (display.unverifiable !== null) return display.unverifiable;
      const pieces = block.kind === "row" ? [display.text] : splitSentences(display.text);
      for (const piece of pieces) {
        const sentence = readSentence(piece, sentinelIds);
        const previous = sentences[sentences.length - 1];
        if (CITATION_ONLY_REMAINDER.test(sentence.text)) {
          if (previous && sentence.groups.length > 0) {
            const ids = sentence.groups.flatMap((group) => group.ids);
            const at = previous.text.length;
            previous.groups.push({ start: at, end: at, ids });
          }
          continue;
        }
        sentences.push(sentence);
      }
    }

    const excerpts = new Map<string, Set<string>>();
    const excerptFor = (id: string): Set<string> => {
      let indexed = excerpts.get(id);
      if (!indexed) {
        indexed = indexExcerpt(contentById.get(id) ?? "", view);
        excerpts.set(id, indexed);
      }
      return indexed;
    };

    // A summary line ("The fee is $5.") is often followed by the cited detail,
    // so a sentence with no citation of its own is checked against every
    // excerpt the answer cites.
    const answerIds = [...new Set(sentences.flatMap((s) => s.groups.flatMap((g) => g.ids)))];
    const asked = question ? indexExcerpt(question, view) : null;

    for (const sentence of sentences) {
      for (const figure of extractFigures(sentence.text, sentence.marked)) {
        // The CSR typed it ("signed up in 2021"); repeating it invents nothing.
        // Money and percentages still need an excerpt, so "is the fee $50?"
        // never confirms a fee the documents do not state.
        const policyFigure = figure.kind === "currency" || figure.kind === "percent";
        if (asked && !policyFigure && excerptHasFigure(asked, figure)) continue;
        const following = sentence.groups.find((group) => group.start >= figure.end);
        const preceding = [...sentence.groups].reverse().find((group) => group.end <= figure.start);
        const ids = (following ?? preceding)?.ids ?? answerIds;
        if (!ids.some((id) => excerptHasFigure(excerptFor(id), figure))) {
          return figure.text;
        }
      }
    }
  }
  return null;
}

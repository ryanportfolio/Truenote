import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Highlighter, Trash2, X } from "lucide-react";
import {
  createKbHighlight,
  deleteKbHighlight,
  listKbHighlights,
  updateKbHighlight
} from "@/lib/api";
import {
  rangeMatchesText,
  rangesOverlap,
  trimSelectedRange,
  type AnchoredTextRange
} from "@/lib/highlightRanges";
import type { KbHighlight, KbHighlightColor } from "@/types/api";

const HIGHLIGHT_COLORS: ReadonlyArray<{
  value: KbHighlightColor;
  label: string;
}> = [
  { value: "yellow", label: "Yellow" },
  { value: "green", label: "Green" },
  { value: "blue", label: "Blue" }
];

const HIGHLIGHT_REGISTRY_NAMES = HIGHLIGHT_COLORS.map(
  ({ value }) => `kb-highlight-${value}`
);
const MAX_HIGHLIGHT_CHARS = 5_000;

interface ViewportAnchor {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

type ToolbarState =
  | {
      mode: "create";
      anchor: ViewportAnchor;
      selection: AnchoredTextRange;
    }
  | {
      mode: "edit";
      anchor: ViewportAnchor;
      highlightId: string;
    };

interface TextNodeSpan {
  node: Text;
  start: number;
  end: number;
}

interface HighlightRegistryLike {
  set(name: string, highlight: unknown): void;
  delete(name: string): boolean;
}

type HighlightConstructor = new (...ranges: Range[]) => unknown;

function textNodeSpans(root: HTMLElement): TextNodeSpan[] {
  const spans: TextNodeSpan[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let current = walker.nextNode();
  while (current) {
    const node = current as Text;
    const length = node.data.length;
    spans.push({ node, start: offset, end: offset + length });
    offset += length;
    current = walker.nextNode();
  }
  return spans;
}

function boundaryAt(
  spans: TextNodeSpan[],
  offset: number,
  preferNext: boolean
): { node: Text; offset: number } | null {
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index];
    if (!span) continue;
    if (offset > span.end) continue;
    if (offset === span.end && preferNext) {
      const next = spans[index + 1];
      if (next && next.start === offset) return { node: next.node, offset: 0 };
    }
    if (offset >= span.start && offset <= span.end) {
      return { node: span.node, offset: offset - span.start };
    }
  }
  return null;
}

function domRangeFromSpans(
  spans: TextNodeSpan[],
  startOffset: number,
  endOffset: number
): Range | null {
  const start = boundaryAt(spans, startOffset, true);
  const end = boundaryAt(spans, endOffset, false);
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

function domRangeForOffsets(
  root: HTMLElement,
  startOffset: number,
  endOffset: number
): Range | null {
  return domRangeFromSpans(textNodeSpans(root), startOffset, endOffset);
}

function rectAnchor(rect: DOMRect): ViewportAnchor {
  return {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left
  };
}

function highlightApi(): {
  registry: HighlightRegistryLike;
  Highlight: HighlightConstructor;
} | null {
  if (typeof window === "undefined" || typeof CSS === "undefined") return null;
  const registry = (CSS as typeof CSS & { highlights?: HighlightRegistryLike })
    .highlights;
  const Highlight = (
    window as typeof window & { Highlight?: HighlightConstructor }
  ).Highlight;
  return registry && Highlight ? { registry, Highlight } : null;
}

function renderHighlights(
  root: HTMLElement,
  highlights: KbHighlight[]
): { cleanup: () => void; supported: boolean } {
  const api = highlightApi();
  if (!api) return { cleanup: () => undefined, supported: false };

  const byColor = new Map<KbHighlightColor, Range[]>();
  const spans = textNodeSpans(root);
  for (const highlight of highlights) {
    const range = domRangeFromSpans(
      spans,
      highlight.startOffset,
      highlight.endOffset
    );
    if (!range) continue;
    const ranges = byColor.get(highlight.color) ?? [];
    ranges.push(range);
    byColor.set(highlight.color, ranges);
  }
  for (const { value } of HIGHLIGHT_COLORS) {
    const ranges = byColor.get(value) ?? [];
    api.registry.set(`kb-highlight-${value}`, new api.Highlight(...ranges));
  }
  return {
    supported: true,
    cleanup: () => {
      for (const name of HIGHLIGHT_REGISTRY_NAMES) api.registry.delete(name);
    }
  };
}

function caretOffsetFromPoint(
  root: HTMLElement,
  clientX: number,
  clientY: number
): number | null {
  const documentWithCaret = document as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number
    ) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = documentWithCaret.caretPositionFromPoint?.(clientX, clientY);
  const fallbackRange = position
    ? null
    : documentWithCaret.caretRangeFromPoint?.(clientX, clientY) ?? null;
  const node = position?.offsetNode ?? fallbackRange?.startContainer;
  const offset = position?.offset ?? fallbackRange?.startOffset;
  if (!node || offset === undefined || !root.contains(node)) return null;
  const prefix = document.createRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(node, offset);
  return prefix.toString().length;
}

function toolbarPosition(anchor: ViewportAnchor): CSSProperties {
  const width = Math.min(292, window.innerWidth - 24);
  const estimatedHeight = 116;
  const gap = 8;
  const center = anchor.left + (anchor.right - anchor.left) / 2;
  const left = Math.max(12, Math.min(center - width / 2, window.innerWidth - width - 12));
  const candidateTop =
    anchor.top >= estimatedHeight + gap + 12
      ? anchor.top - estimatedHeight - gap
      : Math.min(anchor.bottom + gap, window.innerHeight - estimatedHeight - 12);
  const maxTop = Math.max(12, window.innerHeight - estimatedHeight - 12);
  return { width, left, top: Math.min(Math.max(12, candidateTop), maxTop) };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function PassageHighlighter({
  documentId,
  documentVersionId,
  children
}: {
  documentId: string;
  documentVersionId: string;
  children: ReactNode;
}): JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const listToggleRef = useRef<HTMLButtonElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const focusToolbarRef = useRef(false);
  const [highlights, setHighlights] = useState<KbHighlight[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    "loading"
  );
  const [toolbar, setToolbar] = useState<ToolbarState | null>(null);
  const [selectedColor, setSelectedColor] = useState<KbHighlightColor>("yellow");
  const [pending, setPending] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [canWriteHighlights, setCanWriteHighlights] = useState(false);
  const [displaySupported, setDisplaySupported] = useState(true);
  const [notice, setNotice] = useState<{
    kind: "status" | "error";
    text: string;
  } | null>(null);

  const closeToolbar = useCallback((restoreFocus = true) => {
    setToolbar(null);
    window.getSelection()?.removeAllRanges();
    if (restoreFocus && returnFocusRef.current) {
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      requestAnimationFrame(() => target.focus());
    } else {
      returnFocusRef.current = null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadState("loading");
    setHighlights([]);
    setToolbar(null);
    setListOpen(false);
    setCanWriteHighlights(false);
    setDisplaySupported(true);
    setNotice(null);
    void listKbHighlights(documentId)
      .then((response) => {
        if (cancelled) return;
        if (response.documentVersionId !== documentVersionId) {
          setLoadState("error");
          setNotice({
            kind: "error",
            text: "This document changed while it was loading. Reload to use highlights."
          });
          return;
        }
        setHighlights(response.items);
        setCanWriteHighlights(response.canWriteHighlights);
        setLoadState("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadState("error");
        setNotice({
          kind: "error",
          text: `${errorMessage(error, "Highlights could not load")}. You can still read this document.`
        });
      });
    return () => {
      cancelled = true;
    };
  }, [documentId, documentVersionId]);

  useLayoutEffect(() => {
    const root = contentRef.current;
    if (!root || loadState !== "ready") return;
    const content = root.textContent ?? "";
    const renderable = highlights.filter((highlight) =>
      rangeMatchesText(content, highlight)
    );
    const rendered = renderHighlights(root, renderable);
    setDisplaySupported(rendered.supported);
    if (!rendered.supported) {
      setNotice({
        kind: "error",
        text: "This browser cannot display saved highlights. Reading still works."
      });
    } else if (renderable.length !== highlights.length) {
      setNotice({
        kind: "error",
        text: `${highlights.length - renderable.length} saved highlight${
          highlights.length - renderable.length === 1 ? "" : "s"
        } could not be placed in this document version.`
      });
    }
    return rendered.cleanup;
  }, [highlights, loadState]);

  const openEditToolbar = useCallback(
    (highlight: KbHighlight, anchor: ViewportAnchor, returnFocus?: HTMLElement) => {
      if (pending || !canWriteHighlights || !displaySupported) return;
      returnFocusRef.current = returnFocus ?? null;
      setSelectedColor(highlight.color);
      setNotice(null);
      setToolbar({ mode: "edit", highlightId: highlight.id, anchor });
    },
    [canWriteHighlights, displaySupported, pending]
  );

  const openCreateForRange = useCallback(
    (range: Range, focusToolbar: boolean, returnFocus?: HTMLElement) => {
      if (
        loadState !== "ready" ||
        !canWriteHighlights ||
        !displaySupported ||
        pending
      ) {
        return;
      }
      const root = contentRef.current;
      if (
        !root ||
        !root.contains(range.startContainer) ||
        !root.contains(range.endContainer)
      ) {
        return;
      }
      const rawText = range.toString();
      const prefix = document.createRange();
      prefix.selectNodeContents(root);
      prefix.setEnd(range.startContainer, range.startOffset);
      const selected = trimSelectedRange(rawText, prefix.toString().length);
      if (!selected) return;
      if (selected.highlightedText.length > MAX_HIGHLIGHT_CHARS) {
        setNotice({
          kind: "error",
          text: "Choose a shorter passage (5,000 characters or fewer)."
        });
        return;
      }
      if (highlights.some((highlight) => rangesOverlap(selected, highlight))) {
        setNotice({
          kind: "error",
          text: "That passage overlaps an existing highlight. Edit the saved highlight instead."
        });
        return;
      }
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      focusToolbarRef.current = focusToolbar;
      returnFocusRef.current = focusToolbar
        ? returnFocus ?? (document.activeElement as HTMLElement | null)
        : null;
      setSelectedColor("yellow");
      setNotice(null);
      setToolbar({ mode: "create", selection: selected, anchor: rectAnchor(rect) });
    },
    [canWriteHighlights, displaySupported, highlights, loadState, pending]
  );

  const captureSelection = useCallback(
    (focusToolbar: boolean) => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
      openCreateForRange(selection.getRangeAt(0), focusToolbar);
    },
    [openCreateForRange]
  );

  useEffect(() => {
    const handlePointerUp = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (
        target?.closest("[data-kb-highlight-toolbar]") ||
        target?.closest("[data-kb-highlight-list]")
      ) {
        return;
      }
      requestAnimationFrame(() => captureSelection(false));
    };
    document.addEventListener("pointerup", handlePointerUp);
    return () => document.removeEventListener("pointerup", handlePointerUp);
  }, [captureSelection]);

  useEffect(() => {
    if (!toolbar) return;
    if (focusToolbarRef.current) {
      focusToolbarRef.current = false;
      requestAnimationFrame(() =>
        toolbarRef.current?.querySelector<HTMLButtonElement>("button")?.focus()
      );
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) closeToolbar();
    };
    const closeOnPointerDown = (event: PointerEvent) => {
      if (pending) return;
      const target = event.target as Node;
      if (toolbarRef.current?.contains(target)) return;
      closeToolbar(false);
    };
    const closeOnViewportChange = () => {
      if (!pending) closeToolbar(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [closeToolbar, pending, toolbar]);

  const openHighlightAtPoint = useCallback(
    (clientX: number, clientY: number, returnFocus?: HTMLElement) => {
      const root = contentRef.current;
      if (!root) return;
      const offset = caretOffsetFromPoint(root, clientX, clientY);
      if (offset === null) return;
      const highlight = highlights.find(
        (item) => offset >= item.startOffset && offset < item.endOffset
      );
      if (!highlight) return;
      const range = domRangeForOffsets(root, highlight.startOffset, highlight.endOffset);
      if (!range) return;
      openEditToolbar(highlight, rectAnchor(range.getBoundingClientRect()), returnFocus);
    },
    [highlights, openEditToolbar]
  );

  const handleContentClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!canWriteHighlights || !displaySupported || pending) return;
    if (!window.getSelection()?.isCollapsed) return;
    openHighlightAtPoint(event.clientX, event.clientY);
  };

  const handleContentKeyUp = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.shiftKey) captureSelection(true);
  };

  const saveHighlight = async () => {
    if (!toolbar || toolbar.mode !== "create") return;
    setPending(true);
    setNotice(null);
    try {
      const item = await createKbHighlight(documentId, {
        documentVersionId,
        highlightedText: toolbar.selection.highlightedText,
        startOffset: toolbar.selection.startOffset,
        endOffset: toolbar.selection.endOffset,
        color: selectedColor
      });
      setHighlights((current) =>
        [...current, item].sort((a, b) => a.startOffset - b.startOffset)
      );
      setNotice({ kind: "status", text: "Highlight saved." });
      closeToolbar();
    } catch (error) {
      setNotice({
        kind: "error",
        text: errorMessage(error, "Highlight could not be saved")
      });
    } finally {
      setPending(false);
    }
  };

  const changeColor = async (color: KbHighlightColor) => {
    if (!toolbar || toolbar.mode !== "edit" || color === selectedColor) return;
    const previousColor = selectedColor;
    setSelectedColor(color);
    setPending(true);
    setNotice(null);
    try {
      const item = await updateKbHighlight(toolbar.highlightId, color);
      setHighlights((current) =>
        current.map((highlight) => (highlight.id === item.id ? item : highlight))
      );
      setNotice({ kind: "status", text: `Highlight changed to ${color}.` });
    } catch (error) {
      setSelectedColor(previousColor);
      setNotice({
        kind: "error",
        text: errorMessage(error, "Highlight color could not be changed")
      });
    } finally {
      setPending(false);
    }
  };

  const removeHighlight = async () => {
    if (!toolbar || toolbar.mode !== "edit") return;
    const highlightId = toolbar.highlightId;
    setPending(true);
    setNotice(null);
    try {
      await deleteKbHighlight(highlightId);
      const remaining = highlights.filter(
        (highlight) => highlight.id !== highlightId
      );
      setHighlights(remaining);
      if (remaining.length === 0) setListOpen(false);
      setNotice({ kind: "status", text: "Highlight removed." });
      closeToolbar(false);
      requestAnimationFrame(() =>
        (remaining.length > 0 ? listToggleRef.current : headerRef.current)?.focus()
      );
    } catch (error) {
      setNotice({
        kind: "error",
        text: errorMessage(error, "Highlight could not be removed")
      });
    } finally {
      setPending(false);
    }
  };

  const toolbarHighlight =
    toolbar?.mode === "edit"
      ? highlights.find((highlight) => highlight.id === toolbar.highlightId)
      : null;

  return (
    <div>
      <div
        ref={headerRef}
        tabIndex={-1}
        className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/45 px-3 py-2 text-xs focus:outline-none"
      >
        <p className="flex items-center gap-2 text-foreground">
          <Highlighter className="h-4 w-4 text-primary" aria-hidden />
          {loadState === "loading"
            ? "Loading your highlights…"
            : loadState === "error"
              ? "Highlights are unavailable. Reading still works."
              : !displaySupported
                ? "This browser cannot display saved highlights."
                : !canWriteHighlights
                  ? "Highlights are read-only for this account."
                  : "Select a passage to save a personal highlight."}
        </p>
        <div className="flex items-center gap-2">
          {highlights.length > 0 ? (
            <button
              ref={listToggleRef}
              type="button"
              className="btn-whisper gap-1.5 px-3 py-1 text-xs"
              aria-expanded={listOpen}
              disabled={pending}
              onClick={() => setListOpen((open) => !open)}
            >
              {highlights.length} highlight{highlights.length === 1 ? "" : "s"}
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform duration-100 motion-reduce:transition-none ${
                  listOpen ? "rotate-180" : ""
                }`}
                aria-hidden
              />
            </button>
          ) : null}
        </div>
      </div>

      {listOpen ? (
        <div
          data-kb-highlight-list
          className="mb-4 rounded-md border border-border bg-secondary p-2"
        >
          <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">
            Saved passages
          </p>
          <ul className="divide-y divide-border">
            {highlights.map((highlight) => (
              <li key={highlight.id} className="flex items-center gap-2 py-1.5">
                <span
                  className="kb-highlight-swatch h-3 w-3 shrink-0 rounded-full"
                  data-highlight-color={highlight.color}
                  aria-hidden
                />
                {canWriteHighlights && displaySupported ? (
                  <button
                    type="button"
                    className="min-w-0 flex-1 rounded-md px-2 py-1 text-left text-xs leading-relaxed hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    disabled={pending}
                    onClick={(event) => {
                      const range = contentRef.current
                        ? domRangeForOffsets(
                            contentRef.current,
                            highlight.startOffset,
                            highlight.endOffset
                          )
                        : null;
                      const passageRect = range?.getBoundingClientRect();
                      const passageIsVisible =
                        passageRect !== undefined &&
                        passageRect.bottom > 12 &&
                        passageRect.top < window.innerHeight - 12;
                      focusToolbarRef.current = true;
                      openEditToolbar(
                        highlight,
                        rectAnchor(
                          passageIsVisible
                            ? passageRect
                            : event.currentTarget.getBoundingClientRect()
                        ),
                        event.currentTarget
                      );
                    }}
                  >
                    “{highlight.highlightedText.replace(/\s+/gu, " ").slice(0, 140)}
                    {highlight.highlightedText.length > 140 ? "…" : ""}”
                  </button>
                ) : (
                  <p className="min-w-0 flex-1 px-2 py-1 text-xs leading-relaxed">
                    “{highlight.highlightedText.replace(/\s+/gu, " ").slice(0, 140)}
                    {highlight.highlightedText.length > 140 ? "…" : ""}”
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {notice?.kind === "error" ? (
        <p
          role="alert"
          className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {notice.text}
        </p>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite">
        {notice?.kind === "status" ? notice.text : ""}
      </p>

      <div
        ref={contentRef}
        tabIndex={-1}
        onClick={handleContentClick}
        onKeyUp={handleContentKeyUp}
      >
        {children}
      </div>

      {toolbar
        ? createPortal(
            <div
              ref={toolbarRef}
              data-kb-highlight-toolbar
              role="group"
              aria-label={toolbar.mode === "create" ? "Create highlight" : "Edit highlight"}
              className="fixed z-50 rounded-lg border border-border bg-card p-3 shadow-panel"
              style={toolbarPosition(toolbar.anchor)}
            >
              {toolbarHighlight ? (
                <p className="mb-2 truncate text-xs text-muted-foreground">
                  “{toolbarHighlight.highlightedText.replace(/\s+/gu, " ")}”
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <div
                  className="flex items-center gap-1"
                  role="group"
                  aria-label="Highlight color"
                >
                  {HIGHLIGHT_COLORS.map((color) => (
                    <button
                      key={color.value}
                      type="button"
                      className="kb-highlight-color-button"
                      data-highlight-color={color.value}
                      aria-label={`${color.label} highlight`}
                      aria-pressed={selectedColor === color.value}
                      disabled={pending}
                      onClick={() => {
                        if (toolbar.mode === "edit") void changeColor(color.value);
                        else setSelectedColor(color.value);
                      }}
                    >
                      {selectedColor === color.value ? (
                        <Check className="h-3.5 w-3.5" aria-hidden />
                      ) : null}
                    </button>
                  ))}
                </div>
                <span className="h-6 w-px bg-border" aria-hidden />
                {toolbar.mode === "create" ? (
                  <button
                    type="button"
                    className="btn-primary min-h-9 flex-1 px-3 py-1.5 text-xs"
                    disabled={pending}
                    onClick={() => void saveHighlight()}
                  >
                    {pending ? "Saving…" : "Highlight"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-whisper min-h-9 gap-1.5 px-3 py-1.5 text-xs text-destructive"
                    disabled={pending}
                    onClick={() => void removeHighlight()}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    Remove
                  </button>
                )}
                <button
                  type="button"
                  className="btn-icon p-2"
                  aria-label="Close highlight toolbar"
                  disabled={pending}
                  onClick={() => closeToolbar()}
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject
} from "react";
import { createPortal } from "react-dom";
import { Check, type LucideIcon } from "lucide-react";
import { KB_LIBRARY_COLORS, kbColorDot, kbColorLabel } from "@/lib/kbLibraryColors";
import { cn } from "@/lib/utils";
import type { KbLibraryColor } from "@/types/api";

export interface KbMenuItem {
  label: string;
  onSelect: () => void;
  icon?: LucideIcon;
  disabled?: boolean;
  danger?: boolean;
  /** Set for checkbox items; toggling keeps the menu open. */
  checked?: boolean;
  /**
   * With `checked`: a radio item instead (one choice of several, such as
   * "No color" beside the swatches). Picking it closes the menu.
   */
  radio?: boolean;
  /** Color dot shown after the checkbox or icon (color filters, labels). */
  swatch?: KbLibraryColor;
  /** Quiet second text after the label, such as the color under a label's own name. */
  detail?: string;
}

/** A non-interactive group heading with an optional hint line ("Label", "Only you see this."). */
export interface KbMenuHeading {
  kind: "heading";
  label: string;
  hint?: string;
}

/**
 * A row of color swatches, one radio menu item each, named by color ("Blue")
 * so the choice never depends on seeing the hue. Picking one closes the menu.
 */
export interface KbMenuSwatches {
  kind: "swatches";
  /** Visible group label, also the group's accessible name ("My color"). */
  label: string;
  /** Short line under the label, such as who sees the color. */
  hint?: string;
  value: KbLibraryColor | null;
  onSelect: (color: KbLibraryColor) => void;
}

export type KbMenuEntry = KbMenuItem | KbMenuSwatches | KbMenuHeading | "separator";

/**
 * Small action menu (menu button pattern). Portaled with fixed positioning
 * so rows inside clipped cards can still open it. Arrow keys, Home and End
 * move between items; Escape closes and returns focus to the button. With
 * `contextTarget`, a right-click (or the keyboard's menu key) on that element
 * opens the same menu at the pointer instead of the browser's own menu.
 */
export function KbMenu({
  label,
  items,
  children,
  buttonClassName,
  title,
  contextTarget
}: {
  /** Accessible name for the button. */
  label: string;
  items: KbMenuEntry[];
  /** Button content (icon and optional text). */
  children: ReactNode;
  buttonClassName?: string;
  title?: string;
  /** Element whose right-click opens this menu at the pointer. */
  contextTarget?: RefObject<HTMLElement>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // Where a right-click opened the menu; null when the button opened it.
  const pointRef = useRef<{ x: number; y: number } | null>(null);
  const [pointTick, setPointTick] = useState(0);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const focusFirstRef = useRef<"first" | "last">("first");

  const menuItems = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? []);

  const focusedRef = useRef(false);

  /** Place the menu under (or above) its button or the right-click point; false when the button left the viewport. */
  function place(): boolean {
    const button = buttonRef.current;
    const menu = menuRef.current;
    if (!button || !menu) return false;
    const point = pointRef.current;
    if (point) {
      const left = Math.max(8, Math.min(point.x, window.innerWidth - menu.offsetWidth - 8));
      const top =
        point.y + menu.offsetHeight > window.innerHeight - 8 ? Math.max(8, point.y - menu.offsetHeight) : point.y;
      setPosition((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }));
      return true;
    }
    const rect = button.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const below = rect.bottom + 4;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 4) : below;
    setPosition((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }));
    return true;
  }

  useLayoutEffect(() => {
    focusedRef.current = false;
    if (!open) {
      setPosition(null);
      return;
    }
    place();
  }, [open, pointTick]);

  useEffect(() => {
    const target = contextTarget?.current;
    if (!target) return;
    function onContextMenu(event: MouseEvent): void {
      event.preventDefault();
      // The keyboard's menu key reports no pointer; open under the element instead.
      const fromKeyboard = event.clientX === 0 && event.clientY === 0;
      const rect = (target as HTMLElement).getBoundingClientRect();
      pointRef.current = fromKeyboard ? { x: rect.left, y: rect.bottom + 4 } : { x: event.clientX, y: event.clientY };
      focusFirstRef.current = "first";
      setOpen(true);
      setPointTick((n) => n + 1);
    }
    target.addEventListener("contextmenu", onContextMenu);
    return () => target.removeEventListener("contextmenu", onContextMenu);
  }, [contextTarget]);

  // Focus moves into the menu once per opening, after it is positioned and
  // visible: onto the current choice when the menu has one (a color picker
  // opens on the checked color), else the first item.
  useEffect(() => {
    if (!open || !position || focusedRef.current) return;
    focusedRef.current = true;
    const list = menuItems();
    const checked = list.find((el) => el.getAttribute("role") === "menuitemradio" && el.getAttribute("aria-checked") === "true");
    const target = focusFirstRef.current === "last" ? list[list.length - 1] : checked ?? list[0];
    target?.focus({ preventScroll: true });
  }, [open, position]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent): void {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    }
    // Scrolling or resizing keeps the menu beside its button; it closes only
    // when the button leaves the screen.
    function onViewportChange(): void {
      // A menu opened at the pointer would drift from what was clicked; close it.
      if (pointRef.current || !place()) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [open]);

  function close(returnFocus: boolean): void {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }

  function onButtonKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (open && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (open && event.key === "Tab") {
      close(false);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      pointRef.current = null;
      focusFirstRef.current = event.key === "ArrowUp" ? "last" : "first";
      setOpen(true);
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const list = menuItems();
    const index = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      // Back on the button first, so the browser moves Tab on from where the menu was opened.
      close(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      list[(index + 1) % list.length]?.focus();
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      list[(index - 1 + list.length) % list.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      list[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      list[list.length - 1]?.focus();
    }
  }

  function selectSwatch(group: KbMenuSwatches, color: KbLibraryColor): void {
    close(true);
    group.onSelect(color);
  }

  function select(item: KbMenuItem): void {
    if (item.disabled) return;
    if (item.checked !== undefined && !item.radio) {
      item.onSelect();
      return;
    }
    close(true);
    // Run after focus returns so a dialog opened here restores focus to the button.
    item.onSelect();
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        title={title ?? label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          pointRef.current = null;
          focusFirstRef.current = "first";
          setOpen((v) => !v);
        }}
        onKeyDown={onButtonKeyDown}
        className={buttonClassName ?? "btn-icon h-8 w-8"}
      >
        {children}
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label={label}
              onKeyDown={onMenuKeyDown}
              style={{
                top: position?.top ?? 0,
                left: position?.left ?? 0,
                visibility: position ? "visible" : "hidden"
              }}
              // transition-none: the menu is visibility:hidden until positioned. A
              // transition-duration (Tailwind's duration-* sets it) would tween
              // visibility from hidden, and focus() on the first item would miss.
              // The fade runs as an animation, which never touches visibility.
              className="fixed z-40 max-h-[calc(100dvh-1rem)] min-w-[12rem] max-w-[18rem] overflow-y-auto rounded-lg border border-border bg-card py-1 text-sm shadow-panel transition-none motion-safe:animate-in motion-safe:fade-in motion-safe:[animation-duration:100ms]"
            >
              {items.map((entry, i) =>
                entry === "separator" ? (
                  <div key={`sep-${i}`} role="separator" className="my-1 border-t border-border" />
                ) : "kind" in entry && entry.kind === "heading" ? (
                  <div key={`heading-${i}`} role="presentation" className="px-3 pb-1 pt-2">
                    <p className="text-sm font-medium text-foreground">{entry.label}</p>
                    {entry.hint ? <p className="text-xs text-muted-foreground">{entry.hint}</p> : null}
                  </div>
                ) : "kind" in entry ? (
                  <SwatchGroup key={`swatches-${i}`} group={entry} onPick={(color) => selectSwatch(entry, color)} />
                ) : (
                  <button
                    key={`item-${i}`}
                    type="button"
                    role={
                      entry.checked === undefined ? "menuitem" : entry.radio ? "menuitemradio" : "menuitemcheckbox"
                    }
                    aria-checked={entry.checked}
                    disabled={entry.disabled}
                    tabIndex={-1}
                    onClick={() => select(entry)}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left hover:bg-muted focus:bg-muted focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
                      entry.danger ? "text-destructive" : "text-foreground"
                    )}
                  >
                    {entry.radio ? (
                      <span className="grid h-4 w-4 shrink-0 place-items-center" aria-hidden>
                        {entry.checked ? (
                          <Check className="h-4 w-4 text-foreground" strokeWidth={3} />
                        ) : entry.icon ? (
                          <entry.icon className="h-4 w-4 text-muted-foreground" />
                        ) : null}
                      </span>
                    ) : entry.checked !== undefined ? (
                      <span
                        className={cn(
                          "grid h-4 w-4 shrink-0 place-items-center rounded-sm border",
                          entry.checked ? "border-primary bg-primary text-primary-foreground" : "border-input"
                        )}
                        aria-hidden
                      >
                        {entry.checked ? <Check className="h-3 w-3" /> : null}
                      </span>
                    ) : entry.icon ? (
                      <entry.icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    ) : null}
                    {entry.swatch ? (
                      <span
                        aria-hidden
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                        style={kbColorDot(entry.swatch)}
                      />
                    ) : null}
                    <span className={cn("min-w-0 flex-1", entry.radio && entry.checked && "font-medium")}>
                      {entry.label}
                    </span>
                    {entry.detail ? (
                      <span className="shrink-0 text-xs text-muted-foreground">{entry.detail}</span>
                    ) : null}
                  </button>
                )
              )}
            </div>,
            document.body
          )
        : null}
    </>
  );
}

function SwatchGroup({
  group,
  onPick
}: {
  group: KbMenuSwatches;
  onPick: (color: KbLibraryColor) => void;
}): JSX.Element {
  const labelId = useId();
  const hintId = useId();
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-describedby={group.hint ? hintId : undefined}
      className="px-3 pb-1.5 pt-2"
    >
      <p id={labelId} className="text-sm font-medium text-foreground">
        {group.label}
      </p>
      {group.hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {group.hint}
        </p>
      ) : null}
      <div className="mt-2 grid grid-cols-4 gap-1">
        {KB_LIBRARY_COLORS.map((color) => {
          const checked = group.value === color;
          return (
            <button
              key={color}
              type="button"
              role="menuitemradio"
              aria-checked={checked}
              tabIndex={-1}
              onClick={() => onPick(color)}
              className="flex cursor-pointer flex-col items-center gap-1 rounded-md px-1 py-1.5 text-xs text-foreground hover:bg-muted focus:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                aria-hidden
                className={cn(
                  "grid h-6 w-6 place-items-center rounded-full border border-foreground/15",
                  checked && "ring-2 ring-foreground/70 ring-offset-2 ring-offset-card"
                )}
                style={kbColorDot(color)}
              >
                {checked ? <Check className="h-3.5 w-3.5 text-foreground" strokeWidth={3} /> : null}
              </span>
              <span className={cn(checked && "font-medium")}>{kbColorLabel(color)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

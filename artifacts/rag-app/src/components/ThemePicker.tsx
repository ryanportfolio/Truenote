import { useRef, type KeyboardEvent } from "react";
import { Moon, Sun, Sunset, type LucideIcon } from "lucide-react";
import { setTheme, THEMES, useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const OPTIONS: Record<Theme, { label: string; Icon: LucideIcon }> = {
  light: { label: "Light", Icon: Sun },
  dark: { label: "Dark", Icon: Moon },
  warm: { label: "Warm (less blue light)", Icon: Sunset }
};

/**
 * Three-way theme switch (light, dark, warm) as a radio group: one tab
 * stop, arrow keys move and select, the checked option carries the card
 * surface. Used in the top bar and on the auth pages.
 */
export function ThemePicker({ className }: { className?: string }): JSX.Element {
  const theme = useTheme();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const target =
      step !== undefined
        ? (THEMES.indexOf(theme) + step + THEMES.length) % THEMES.length
        : e.key === "Home"
          ? 0
          : e.key === "End"
            ? THEMES.length - 1
            : null;
    const next = target === null ? undefined : THEMES[target];
    if (target === null || !next) return;
    e.preventDefault();
    setTheme(next);
    buttons.current[target]?.focus();
  }

  return (
    <div role="radiogroup" aria-label="Theme" className={cn("theme-picker", className)} onKeyDown={onKeyDown}>
      {THEMES.map((option, i) => {
        const { label, Icon } = OPTIONS[option];
        const checked = option === theme;
        return (
          <button
            key={option}
            ref={(el) => {
              buttons.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={label}
            title={label}
            tabIndex={checked ? 0 : -1}
            onClick={() => setTheme(option)}
            className="theme-picker-option"
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}

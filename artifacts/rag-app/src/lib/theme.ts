import { useSyncExternalStore } from "react";

/**
 * Site theme: light (default), dark, or warm (amber paper, brown ink, less
 * blue light). Stored per browser; index.html applies the stored theme
 * before first paint, so a reload never flashes the light palette.
 * Tokens per theme live in index.css under `:root[data-theme="…"]`.
 */
export type Theme = "light" | "dark" | "warm";

export const THEMES: readonly Theme[] = ["light", "dark", "warm"];

/** Read by the inline script in index.html; keep the two in step. */
export const THEME_STORAGE_KEY = "truenote.theme";

/** Browser chrome color per theme (the `--background` hex). */
const THEME_COLOR: Record<Theme, string> = {
  light: "#E8E6DE",
  dark: "#14171D",
  warm: "#E9D8A6"
};

const CHANGE_EVENT = "truenote-theme-change";

function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

export function getTheme(): Theme {
  if (typeof document === "undefined") return "light";
  const applied = document.documentElement.dataset.theme;
  return isTheme(applied) ? applied : "light";
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "light") delete root.dataset.theme;
  else root.dataset.theme = theme;
  // Tailwind's `dark:` variant keys off the class.
  root.classList.toggle("dark", theme === "dark");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
}

export function setTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    if (theme === "light") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage blocked (private mode, policy): the theme holds for this page.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  // Another tab changing the theme updates this one too.
  const onStorage = (e: StorageEvent): void => {
    if (e.key !== THEME_STORAGE_KEY) return;
    applyTheme(isTheme(e.newValue) ? e.newValue : "light");
    onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, () => "light");
}

import { useSyncExternalStore } from "react";

/** Light or dark: the viewer's choice when they made one in this browser, otherwise their system's. */
export type Theme = "light" | "dark";
const KEY = "treasury.theme";
const media = () => window.matchMedia("(prefers-color-scheme: dark)");

function stored(): Theme | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

const current = (): Theme => stored() ?? (media().matches ? "dark" : "light");
const listeners = new Set<() => void>();

function apply(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  // Arc's accent: amber, the Treasury's yellow.
  root.dataset.accent = "amber";
  for (const listener of listeners) listener();
}

/** Sets the theme before the first render, and follows the system while the viewer hasn't chosen. */
export function initTheme() {
  apply(current());
  media().addEventListener("change", () => { if (!stored()) apply(current()); });
}

export function setTheme(theme: Theme) {
  try { localStorage.setItem(KEY, theme); } catch { /* a private window keeps the choice for this page only */ }
  apply(theme);
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => listeners.delete(listener); },
    () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"),
  );
}

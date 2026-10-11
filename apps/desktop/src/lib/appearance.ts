export type ThemeId = "midnight" | "slate" | "paper";
export type FontId = "mono" | "sans";
export type DensityId = "compact" | "comfortable" | "spacious";

export interface Appearance {
  theme: ThemeId;
  font: FontId;
  density: DensityId;
}

export const THEMES: Array<{ id: ThemeId; label: string; dark: boolean; swatch: [string, string, string] }> = [
  { id: "midnight", label: "Midnight", dark: true, swatch: ["#0b0d10", "#181c22", "#e3a857"] },
  { id: "slate", label: "Slate", dark: true, swatch: ["#282c34", "#2e333c", "#e06c75"] },
  { id: "paper", label: "Paper", dark: false, swatch: ["#f6f5f2", "#efede8", "#b4531c"] },
];

export const DEFAULT_APPEARANCE: Appearance = { theme: "midnight", font: "mono", density: "comfortable" };
const KEY = "betacode.appearance";

export function loadAppearance(): Appearance {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Appearance> | null;
    return {
      theme: THEMES.some((t) => t.id === raw?.theme) ? raw!.theme! : DEFAULT_APPEARANCE.theme,
      font: raw?.font === "sans" || raw?.font === "mono" ? raw.font : DEFAULT_APPEARANCE.font,
      density: raw?.density === "compact" || raw?.density === "spacious" || raw?.density === "comfortable" ? raw.density : DEFAULT_APPEARANCE.density,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function applyAppearance(a: Appearance, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = a.theme;
  root.dataset.font = a.font;
  root.dataset.density = a.density;
  root.classList.toggle("dark", THEMES.find((t) => t.id === a.theme)?.dark ?? true);
}

export function saveAppearance(a: Appearance): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {
    /* storage unavailable: the choice just will not persist */
  }
}

export const isDarkTheme = (a: Appearance) => THEMES.find((t) => t.id === a.theme)?.dark ?? true;

import type { Theme } from "@glideapps/glide-data-grid";

/** Used when a token isn't defined (tests, or before the stylesheet loads): the platform's text colour. */
const FALLBACK = "CanvasText";

/** Resolve a design token (`--text`, `syn-number`, …) to a colour string. */
export function token(name: string, root: Element = document.documentElement): string {
  const key = name.startsWith("--") ? name : `--${name}`;
  const value = getComputedStyle(root).getPropertyValue(key).trim();
  return value || FALLBACK;
}

const px = (name: string, fallback: number, root: Element) => {
  const n = parseFloat(getComputedStyle(root).getPropertyValue(name));
  return Number.isFinite(n) ? n : fallback;
};

export const ROW_HEIGHT = 26;
export const HEADER_HEIGHT = 40;

/** The grid theme, built from the stylesheet's tokens so it follows them. */
export function gridTheme(root: Element = document.documentElement): Theme {
  const t = (n: string) => token(n, root);
  const font = getComputedStyle(root).getPropertyValue("--font-mono").trim() || "monospace";
  return {
    accentColor: t("accent"),
    accentFg: t("bg-app"),
    accentLight: t("bg-selected"),
    textDark: t("text"),
    textMedium: t("text-secondary"),
    textLight: t("text-dim"),
    textBubble: t("text"),
    bgIconHeader: t("text-muted"),
    fgIconHeader: t("bg-raised"),
    textHeader: t("text-secondary"),
    textGroupHeader: t("text-muted"),
    textHeaderSelected: t("text"),
    bgCell: t("bg-app"),
    bgCellMedium: t("bg-panel"),
    bgHeader: t("bg-raised"),
    bgHeaderHasFocus: t("bg-segment-active"),
    bgHeaderHovered: t("bg-hover"),
    bgBubble: t("bg-raised"),
    bgBubbleSelected: t("bg-segment-active"),
    bgSearchResult: t("grid-edited-cell"),
    borderColor: t("border-subtle"),
    drilldownBorder: t("border"),
    linkColor: t("syn-link"),
    cellHorizontalPadding: 10,
    cellVerticalPadding: 3,
    headerFontStyle: `600 ${px("--fs-grid", 12, root)}px`,
    baseFontStyle: `${px("--fs-grid", 12, root)}px`,
    fontFamily: font,
    markerFontStyle: `${px("--fs-grid", 12, root)}px`,
    editorFontSize: `${px("--fs-grid", 12, root)}px`,
    lineHeight: 1.5,
    headerIconSize: 16,
    horizontalBorderColor: t("border-subtle"),
    headerBottomBorderColor: t("border"),
    resizeIndicatorColor: t("accent"),
    roundingRadius: 0,
  };
}

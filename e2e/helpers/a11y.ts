import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { browser } from "@wdio/globals";

const axeSource = () =>
  readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

export interface AxeViolation {
  id: string;
  impact: string;
  help: string;
  nodes: string[];
}

/** Serious and critical axe-core violations of the page as it is now (names, roles, contrast, labels, ARIA). */
export async function seriousViolations(): Promise<AxeViolation[]> {
  await browser.execute(axeSource());
  const all = await browser.executeAsync((done: (v: AxeViolation[]) => void) => {
    const axe = (
      window as unknown as {
        axe: {
          run(o: object): Promise<{
            violations: {
              id: string;
              impact: string;
              help: string;
              nodes: { target: unknown[]; any: { message: string }[] }[];
            }[];
          }>;
        };
      }
    ).axe;
    axe
      .run({ resultTypes: ["violations"] })
      .then((r) =>
        done(
          r.violations.map((v) => ({
            id: v.id,
            impact: v.impact,
            help: v.help,
            nodes: v.nodes.map(
              (n) => `${n.target.join(" ")}${n.any[0] ? ` (${n.any[0].message})` : ""}`,
            ),
          })),
        ),
      )
      .catch((e: unknown) =>
        done([{ id: "axe-error", impact: "critical", help: String(e), nodes: [] }]),
      );
  });
  return all.filter((v) => v.impact === "serious" || v.impact === "critical");
}

export function describeViolations(v: AxeViolation[]): string {
  return v
    .map((x) => `${x.id} (${x.impact}): ${x.help} [${x.nodes.slice(0, 3).join(" | ")}]`)
    .join("\n");
}

export interface FocusInfo {
  tag: string;
  label: string;
  x: number;
  y: number;
  outlineWidth: string;
  outlineColor: string;
  accent: string;
}

/** The focused element: its name, position and focus outline, with `--accent` resolved. */
export async function focusInfo(): Promise<FocusInfo> {
  return browser.execute(() => {
    const el = document.activeElement as HTMLElement;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const probe = document.createElement("span");
    probe.style.color = "var(--accent)";
    document.body.appendChild(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return {
      tag: el.tagName.toLowerCase(),
      label: el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? "",
      x: r.x,
      y: r.y,
      outlineWidth: cs.outlineWidth,
      outlineColor: cs.outlineColor,
      accent,
    };
  });
}

export interface Stop {
  label: string;
  x: number;
  y: number;
}

/**
 * Tab stops inside a region in the order the browser visits them (DOM order of focusable,
 * non-negative-tabindex controls). The embedded WebDriver's Tab key does not move focus, so the
 * order is computed from the page rather than pressed.
 */
export async function tabStops(regionSelector: string): Promise<Stop[]> {
  return browser.execute((sel: string) => {
    const region = document.querySelector(sel);
    if (!region) return [];
    const nodes = region.querySelectorAll<HTMLElement>(
      "a[href], button, input, select, textarea, [tabindex]",
    );
    return Array.from(nodes)
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const disabled = (el as HTMLButtonElement).disabled === true;
        return el.tabIndex >= 0 && !disabled && r.width > 0 && r.height > 0;
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          label: el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30) ?? "",
          x: r.x,
          y: r.y,
        };
      });
  }, regionSelector);
}

/** Focus the first tab stop of a region by keyboard-modality focus and describe its outline. */
export async function focusFirstStop(
  regionSelector: string,
): Promise<FocusInfo & { focusVisible: boolean }> {
  await browser.keys("Tab"); // marks the interaction as keyboard, so :focus-visible applies
  return browser.execute((sel: string) => {
    const region = document.querySelector(sel)!;
    const el = Array.from(
      region.querySelectorAll<HTMLElement>("button, a[href], input, [tabindex]"),
    ).find((e) => e.tabIndex >= 0)!;
    el.focus();
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const probe = document.createElement("span");
    probe.style.color = "var(--accent)";
    document.body.appendChild(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return {
      tag: el.tagName.toLowerCase(),
      label: el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? "",
      x: r.x,
      y: r.y,
      outlineWidth: cs.outlineWidth,
      outlineColor: cs.outlineColor,
      accent,
      focusVisible: el.matches(":focus-visible"),
    };
  }, regionSelector);
}

// Pure parts of the third-party license bundle (spec: release-packaging › Open-source project
// files, Incompatible license): the allow-list, which packages are shipped, and the HTML.

/** Licenses a dependency that ships with Clew may use. Keep in step with src-tauri/deny.toml. */
export const ALLOWED = [
  "MIT",
  "Apache-2.0",
  "Apache-2.0 WITH LLVM-exception",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MPL-2.0",
  "Zlib",
  "Unicode-DFS-2016",
  "Unicode-3.0",
  "CC0-1.0",
  "BSL-1.0",
  "CDLA-Permissive-2.0",
  // The fonts (IBM Plex Sans, JetBrains Mono) are SIL OFL fonts, and 0BSD (tslib) is a
  // public-domain-equivalent: both are permissive.
  "OFL-1.1",
  "0BSD",
] as const;

/**
 * Whether an SPDX expression may ship: `A OR B` needs one allowed side, `A AND B` needs both,
 * parentheses group. Unknown or empty licenses are not allowed.
 */
export function isAllowed(expression: string, allowed: readonly string[] = ALLOWED): boolean {
  const tokens = expression.match(/\(|\)|\bAND\b|\bOR\b|\bWITH\b|[^\s()]+/g) ?? [];
  let i = 0;
  /** A missing operand (`MIT OR`) makes the whole expression invalid. */
  let malformed = false;
  const parseOr = (): boolean => {
    let v = parseAnd();
    while (tokens[i] === "OR") {
      i++;
      const r = parseAnd();
      v = v || r;
    }
    return v;
  };
  const parseAnd = (): boolean => {
    let v = parseAtom();
    while (tokens[i] === "AND") {
      i++;
      const r = parseAtom();
      v = v && r;
    }
    return v;
  };
  const parseAtom = (): boolean => {
    const t = tokens[i++];
    if (t === "(") {
      const v = parseOr();
      if (tokens[i] === ")") i++;
      return v;
    }
    if (!t || t === ")" || t === "AND" || t === "OR") {
      malformed = true;
      return false;
    }
    let id = t;
    if (tokens[i] === "WITH") {
      id = `${t} WITH ${tokens[i + 1] ?? ""}`;
      i += 2;
    }
    return allowed.includes(id);
  };
  const result = parseOr();
  return result && !malformed && i >= tokens.length;
}

/** The package directory a bundled module path belongs to, or null for the app's own files. */
export function packageOfModule(id: string): { name: string; dir: string } | null {
  const clean = id.replace(/\\/g, "/").split("?")[0];
  const marker = "/node_modules/";
  const at = clean.lastIndexOf(marker);
  if (at < 0) return null;
  const rest = clean.slice(at + marker.length).split("/");
  const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  if (!name || name.startsWith(".")) return null;
  return { name, dir: clean.slice(0, at + marker.length) + name };
}

export interface Entry {
  name: string;
  version: string;
  license: string;
  /** Full license text. */
  text: string;
  homepage?: string;
}

/** Entries whose license may not ship. */
export function disallowed(entries: Entry[], allowed: readonly string[] = ALLOWED): Entry[] {
  return entries.filter((e) => !isAllowed(e.license, allowed));
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * One page: Clew's own license, then every distinct license text once with the packages that use
 * it. Self-contained (inline style, no scripts) so the About dialog can show it in a sandbox.
 */
export function renderLicensesHtml(clewLicense: string, entries: Entry[]): string {
  const byText = new Map<string, { license: string; items: Entry[] }>();
  for (const e of entries) {
    const key = e.text.trim();
    const group = byText.get(key) ?? { license: e.license, items: [] };
    group.items.push(e);
    byText.set(key, group);
  }
  const groups = [...byText.entries()].sort(
    (a, b) => b[1].items.length - a[1].items.length || a[1].license.localeCompare(b[1].license),
  );
  const sections = groups
    .map(([text, g]) => {
      const names = [...new Set(g.items.map((i) => `${i.name} ${i.version}`))].sort();
      return `<section><h3>${esc(g.license)}</h3><p class="used">Used by: ${names.map(esc).join(", ")}</p><pre>${esc(text)}</pre></section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Third-party licenses</title>
<style>
body{margin:0;padding:20px 24px;background:#14171c;color:#c9ced6;font:13px/1.5 system-ui,sans-serif}
h1{font-size:16px;color:#e6e8eb;margin:0 0 4px}h2{font-size:14px;color:#e6e8eb;margin:24px 0 8px}h3{font-size:13px;color:#e3a64f;margin:20px 0 4px}
p{margin:4px 0}.used{color:#9aa3ae;font-size:12px;overflow-wrap:anywhere}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#0e1014;border:1px solid #262b33;border-radius:6px;padding:10px;font:11.5px/1.5 ui-monospace,monospace}
</style></head><body>
<h1>Third-party licenses</h1>
<p>Clew itself is released under the MIT License. It includes the open-source software below.</p>
<h2>Clew</h2><pre>${esc(clewLicense.trim())}</pre>
<h2>Dependencies (${entries.length})</h2>
${sections}
</body></html>
`;
}

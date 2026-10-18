import { describe, expect, it } from "vitest";
import {
  ALLOWED,
  disallowed,
  isAllowed,
  packageOfModule,
  renderLicensesHtml,
} from "./licenses-lib";
import type { Entry } from "./licenses-lib";

describe("isAllowed (spec: release-packaging › Incompatible license)", () => {
  it("accepts the allow-list and nothing else", () => {
    for (const l of ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC", "MPL-2.0", "Zlib", "CC0-1.0"]) {
      expect(isAllowed(l)).toBe(true);
    }
    for (const l of [
      "GPL-3.0",
      "AGPL-3.0-only",
      "LGPL-2.1",
      "SSPL-1.0",
      "UNLICENSED",
      "",
      "Python-2.0",
    ]) {
      expect(isAllowed(l)).toBe(false);
    }
  });

  it("handles OR, AND, parentheses and WITH", () => {
    expect(isAllowed("MIT OR Apache-2.0")).toBe(true);
    expect(isAllowed("GPL-3.0 OR MIT")).toBe(true); // one allowed choice is enough
    expect(isAllowed("MIT AND GPL-3.0")).toBe(false); // both are required
    expect(isAllowed("(MIT OR GPL-3.0) AND ISC")).toBe(true);
    expect(isAllowed("Apache-2.0 WITH LLVM-exception")).toBe(true);
    expect(isAllowed("GPL-2.0 WITH Classpath-exception-2.0")).toBe(false);
    expect(isAllowed("MIT OR")).toBe(false);
  });

  it("is restricted to the list it is given", () => {
    expect(isAllowed("MIT", ["ISC"])).toBe(false);
    expect(ALLOWED).toContain("OFL-1.1");
  });
});

const entry = (name: string, license: string, text = license + " text"): Entry => ({
  name,
  version: "1.0.0",
  license,
  text,
});

describe("disallowed", () => {
  it("names the dependency with the bad license", () => {
    const bad = disallowed([entry("fine", "MIT"), entry("evil-lib", "GPL-3.0")]);
    expect(bad.map((e) => e.name)).toEqual(["evil-lib"]);
  });
});

describe("packageOfModule", () => {
  it("finds the package of a pnpm path, scoped or not, and ignores app files", () => {
    expect(
      packageOfModule("/p/node_modules/.pnpm/react@18.3.1/node_modules/react/index.js")?.name,
    ).toBe("react");
    expect(
      packageOfModule(
        "/p/node_modules/.pnpm/@codemirror+view@6.0.0/node_modules/@codemirror/view/dist/index.js",
      )?.name,
    ).toBe("@codemirror/view");
    expect(packageOfModule("C:\\p\\node_modules\\zustand\\esm\\index.mjs")?.name).toBe("zustand");
    expect(packageOfModule("/p/src/main.tsx")).toBeNull();
    expect(packageOfModule("\u0000vite/preload-helper")).toBeNull();
  });
});

describe("renderLicensesHtml", () => {
  it("lists each distinct text once with the packages that use it, escaped", () => {
    const html = renderLicensesHtml("MIT License\nCopyright ADK", [
      entry("a", "MIT", "same"),
      entry("b", "MIT", "same"),
      entry("<x>", "ISC", "other & text"),
    ]);
    expect(html.match(/<h3>MIT<\/h3>/g)).toHaveLength(1);
    expect(html).toContain("Used by: a 1.0.0, b 1.0.0");
    expect(html).toContain("&lt;x&gt; 1.0.0");
    expect(html).toContain("other &amp; text");
    expect(html).toContain("Copyright ADK");
    expect(html).not.toContain("<script");
  });
});

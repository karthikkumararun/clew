import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TEMPLATE_PATH,
  UNSIGNED_CAVEATS,
  UNSIGNED_POSTFLIGHT,
  parseChecksums,
  renderCask,
} from "./render-cask";

const template = readFileSync(TEMPLATE_PATH, "utf8");
const DIGEST = "a".repeat(64);
const sums = (name = "Clew_0.1.0_universal.dmg", digest = DIGEST) =>
  `${"b".repeat(64)}  Clew_0.1.0_x64.exe\n${digest}  ${name}\n`;
const render = (over: Partial<Parameters<typeof renderCask>[0]> = {}) =>
  renderCask({ template, version: "0.1.0", checksums: sums(), ...over });

describe("render-cask (spec: homebrew-packaging › Cask rendering)", () => {
  it("renders a stable release with the postflight and caveat", () => {
    const cask = render();
    expect(cask).toContain('version "0.1.0"');
    expect(cask).toContain(`sha256 "${DIGEST}"`);
    expect(cask).toContain("postflight_steps do");
    expect(cask).toContain("caveats <<~EOS");
    expect(cask).toContain("com.apple.quarantine");
    expect(cask).toContain("depends_on macos: :monterey");
  });

  it("keeps Homebrew's {{appdir}} and leaves no template placeholder", () => {
    const cask = render();
    expect(cask).toContain("{{appdir}}/Clew.app");
    expect(cask).not.toMatch(/@[A-Z0-9_]+@/);
  });

  it("omits postflight and caveat for a signed release", () => {
    const cask = render({ signed: true });
    expect(cask).not.toContain("postflight_steps");
    expect(cask).not.toContain("caveats");
    expect(cask).not.toContain("quarantine");
    expect(cask).not.toMatch(/@[A-Z0-9_]+@/);
    expect(cask).toContain("zap trash:");
  });

  it("refuses a pre-release or malformed version", () => {
    for (const version of ["0.2.0-rc.1", "v0.1.0", "1.0", "01.0.0"]) {
      expect(() => render({ version })).toThrow(/only stable/);
    }
  });

  it("names the missing installer entry", () => {
    expect(() => render({ checksums: sums("Other.dmg") })).toThrow(/Clew_0\.1\.0_universal\.dmg/);
  });

  it("refuses a malformed digest", () => {
    expect(() => render({ checksums: sums(undefined, "xyz") })).toThrow(/64 lowercase hex/);
    expect(() => render({ checksums: sums(undefined, "A".repeat(64)) })).toThrow(/64 lowercase/);
  });

  it("parses sha256sum output including the binary mark", () => {
    expect(parseChecksums(`${DIGEST} *a.dmg\r\n${DIGEST}  b.exe\n`)).toEqual({
      "a.dmg": DIGEST,
      "b.exe": DIGEST,
    });
  });

  it("the caveat says how to open a manual download and what uninstall leaves", () => {
    expect(UNSIGNED_CAVEATS).toContain("xattr -dr com.apple.quarantine /Applications/Clew.app");
    expect(UNSIGNED_CAVEATS).toContain('keychain (service "Clew")');
    expect(UNSIGNED_POSTFLIGHT).toContain("/usr/bin/xattr");
  });

  it("zap removes support files but never the user's scripts or the keychain", () => {
    const zap = template.slice(template.indexOf("zap trash"));
    expect(zap).toContain("~/Library/Application Support/Clew");
    expect(zap).toContain("~/Library/WebKit/dev.adk.clew");
    expect(zap).not.toContain("Documents");
  });
});

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bumpVersion,
  isSemver,
  setCargoVersion,
  setJsonVersion,
  setLockVersion,
} from "./bump-version";
import { checkTag, cargoVersion } from "./lib";

const CARGO = `[package]\nname = "clew"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1.0.0" }\n`;
const LOCK = `[[package]]\nname = "clew"\nversion = "0.1.0"\n\n[[package]]\nname = "other"\nversion = "0.1.0"\n`;
const JSON_TEXT = `{\n  "name": "clew",\n  "version": "0.1.0",\n  "x": { "version": "0.1.0" }\n}\n`;

function project() {
  const root = mkdtempSync(join(tmpdir(), "bump-"));
  mkdirSync(join(root, "src-tauri"));
  writeFileSync(join(root, "package.json"), JSON_TEXT);
  writeFileSync(join(root, "src-tauri/tauri.conf.json"), JSON_TEXT);
  writeFileSync(join(root, "src-tauri/Cargo.toml"), CARGO);
  writeFileSync(join(root, "src-tauri/Cargo.lock"), LOCK);
  return root;
}

describe("bump-version", () => {
  it("accepts semantic versions only", () => {
    for (const v of ["0.2.0", "1.0.0-beta.1", "10.20.30"]) expect(isSemver(v)).toBe(true);
    for (const v of ["1.0", "v1.0.0", "01.0.0", "1.0.0+build", "abc"])
      expect(isSemver(v)).toBe(false);
  });

  it("edits the top-level JSON version only, keeping formatting", () => {
    const out = setJsonVersion(JSON_TEXT, "f", "0.2.0");
    expect(out).toBe(JSON_TEXT.replace('"version": "0.1.0",\n  "x"', '"version": "0.2.0",\n  "x"'));
  });

  it("edits only the package version in Cargo.toml and only clew in Cargo.lock", () => {
    expect(setCargoVersion(CARGO, "0.2.0")).toContain('name = "clew"\nversion = "0.2.0"');
    expect(setCargoVersion(CARGO, "0.2.0")).toContain('serde = { version = "1.0.0" }');
    const lock = setLockVersion(LOCK, "0.2.0");
    expect(lock).toContain('name = "clew"\nversion = "0.2.0"');
    expect(lock).toContain('name = "other"\nversion = "0.1.0"');
  });

  it("makes every file agree, so the release tag check passes", () => {
    const root = project();
    const files = bumpVersion(root, "0.2.0");
    expect(files).toHaveLength(4);
    const read = (f: string) => readFileSync(join(root, f), "utf8");
    const versions = {
      "package.json": (JSON.parse(read("package.json")) as { version: string }).version,
      "tauri.conf.json": (JSON.parse(read("src-tauri/tauri.conf.json")) as { version: string })
        .version,
      "Cargo.toml": cargoVersion(read("src-tauri/Cargo.toml")),
    };
    expect(checkTag("v0.2.0", versions).version).toBe("0.2.0");
  });

  it("writes nothing when one file cannot be updated", () => {
    const root = project();
    writeFileSync(join(root, "src-tauri/Cargo.lock"), "nothing here");
    expect(() => bumpVersion(root, "0.2.0")).toThrow(/Cargo.lock/);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(JSON_TEXT);
  });

  it("refuses an invalid or unchanged version", () => {
    const root = project();
    expect(() => bumpVersion(root, "1.0")).toThrow(/not a version/);
    expect(() => bumpVersion(root, "0.1.0")).toThrow(/already/);
  });
});

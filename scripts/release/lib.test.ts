import { describe, expect, it } from "vitest";
import {
  ReleaseError,
  cargoVersion,
  checkTag,
  checksumLines,
  releaseAssets,
  unsignedNote,
  updaterManifest,
} from "./lib";

describe("checkTag (spec: release-packaging › Tag a release)", () => {
  const same = { "package.json": "0.1.0", "tauri.conf.json": "0.1.0", "Cargo.toml": "0.1.0" };

  it("accepts a version tag that matches every file", () => {
    expect(checkTag("v0.1.0", same)).toEqual({
      version: "0.1.0",
      tag: "v0.1.0",
      prerelease: false,
    });
  });

  it("marks a pre-release version", () => {
    const v = { "package.json": "0.2.0-beta.1" };
    expect(checkTag("v0.2.0-beta.1", v)).toMatchObject({
      version: "0.2.0-beta.1",
      prerelease: true,
    });
  });

  it("refuses a tag that is not a version tag", () => {
    for (const t of ["0.1.0", "v1", "release-1", "v1.2.3.4", ""]) {
      expect(() => checkTag(t, same)).toThrow(ReleaseError);
    }
  });

  it("names every file whose version differs", () => {
    expect(() => checkTag("v0.2.0", same)).toThrow(
      "tag v0.2.0 does not match: package.json says 0.1.0, tauri.conf.json says 0.1.0, Cargo.toml says 0.1.0",
    );
    expect(() => checkTag("v0.1.0", { ...same, "Cargo.toml": "0.0.9" })).toThrow(
      "Cargo.toml says 0.0.9",
    );
  });
});

describe("cargoVersion", () => {
  it("reads the package version, not a dependency's", () => {
    const toml = `[package]\nname = "clew"\nversion = "0.3.1"\n\n[dependencies]\nserde = { version = "1" }\n`;
    expect(cargoVersion(toml)).toBe("0.3.1");
    expect(() => cargoVersion("[dependencies]\n")).toThrow();
  });
});

describe("releaseAssets (spec: release-packaging › Installers for macOS and Windows)", () => {
  it("names macOS and Windows files Clew_<version>_<platform>.<ext>", () => {
    const assets = releaseAssets("0.1.0", [
      "src-tauri/target/universal-apple-darwin/release/bundle/dmg/Clew_0.1.0_universal.dmg",
      "src-tauri/target/universal-apple-darwin/release/bundle/macos/Clew.app.tar.gz",
      "src-tauri/target/universal-apple-darwin/release/bundle/macos/Clew.app.tar.gz.sig",
      "src-tauri/target/release/bundle/nsis/Clew_0.1.0_x64-setup.exe",
      "src-tauri/target/release/bundle/nsis/Clew_0.1.0_x64-setup.exe.sig",
      "src-tauri/target/release/bundle/msi/Clew_0.1.0_x64_en-US.msi",
      "src-tauri/target/release/bundle/macos/Clew.app/Contents/Info.plist",
    ]);
    expect(assets.map((a) => a.name)).toEqual([
      "Clew_0.1.0_universal.dmg",
      "Clew_0.1.0_universal.app.tar.gz",
      "Clew_0.1.0_universal.app.tar.gz.sig",
      "Clew_0.1.0_x64.exe",
      "Clew_0.1.0_x64.exe.sig",
      "Clew_0.1.0_x64.msi",
    ]);
  });

  it("understands Windows paths", () => {
    const [a] = releaseAssets("1.0.0", [
      "src-tauri\\target\\release\\bundle\\nsis\\Clew_1.0.0_x64-setup.exe",
    ]);
    expect(a.name).toBe("Clew_1.0.0_x64.exe");
  });
});

describe("checksumLines", () => {
  it("writes `<sha256>  <name>` lines sorted by name", () => {
    const text = checksumLines([
      { name: "b.txt", data: "hello" },
      { name: "a.txt", data: "" },
    ]);
    expect(text).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  a.txt\n" +
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  b.txt\n",
    );
  });
});

describe("updaterManifest", () => {
  const base = {
    version: "0.2.0",
    notes: "Faster grid",
    date: "2026-11-01T00:00:00Z",
    repo: "karthikkumararun/clew",
    tag: "v0.2.0",
  };

  it("points both macOS architectures at the universal archive and Windows at the setup", () => {
    const m = updaterManifest({
      ...base,
      signatures: {
        "Clew_0.2.0_universal.app.tar.gz.sig": "MAC-SIG\n",
        "Clew_0.2.0_x64.exe.sig": "WIN-SIG",
      },
    });
    expect(m.version).toBe("0.2.0");
    expect(m.platforms["darwin-aarch64"]).toEqual({
      signature: "MAC-SIG",
      url: "https://github.com/karthikkumararun/clew/releases/download/v0.2.0/Clew_0.2.0_universal.app.tar.gz",
    });
    expect(m.platforms["darwin-x86_64"].url).toBe(m.platforms["darwin-aarch64"].url);
    expect(m.platforms["windows-x86_64"].url).toMatch(/Clew_0\.2\.0_x64\.exe$/);
  });

  it("leaves out a platform without a signature, and refuses to publish with none", () => {
    const m = updaterManifest({ ...base, signatures: { "Clew_0.2.0_x64.exe.sig": "S" } });
    expect(Object.keys(m.platforms)).toEqual(["windows-x86_64"]);
    expect(() => updaterManifest({ ...base, signatures: {} })).toThrow(/signatures/);
  });
});

describe("unsignedNote (spec: release-packaging › Fork without secrets)", () => {
  it("explains how to open an unsigned macOS and Windows build", () => {
    const n = unsignedNote({ macos: false, windows: false });
    expect(n).toContain("Unsigned build");
    expect(n).toContain("xattr -dr com.apple.quarantine");
    expect(n).toContain("SmartScreen");
  });

  it("says nothing when both are signed, and only what applies otherwise", () => {
    expect(unsignedNote({ macos: true, windows: true })).toBe("");
    expect(unsignedNote({ macos: true, windows: false })).not.toContain("macOS");
  });
});

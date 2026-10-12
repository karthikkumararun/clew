import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseProfiles, sourceHash, splitByProfiles } from "./qa-lib";

describe("selecting profiles (spec: release-qa › Selecting profiles)", () => {
  it("parses a list and rejects unknown names", () => {
    expect(parseProfiles("core,nosql", ["core"])).toEqual(["core", "nosql"]);
    expect(parseProfiles(undefined, ["core"])).toEqual(["core"]);
    expect(() => parseProfiles("core,oops", [])).toThrow(/oops/);
  });

  it("skips journeys whose profile is not running and lists them", () => {
    const needs = { "J-01": ["core"], "J-02": ["core", "nosql"] };
    const files = ["J-01-a.e2e.ts", "J-02-b.e2e.ts", "J-11-c.e2e.ts"];
    const { run, skipped } = splitByProfiles(files, needs, ["core"]);
    expect(run).toEqual(["J-01-a.e2e.ts", "J-11-c.e2e.ts"]);
    expect(skipped).toEqual([{ file: "J-02-b.e2e.ts", missing: ["nosql"] }]);
  });
});

describe("build freshness", () => {
  it("hashes the sources deterministically", () => {
    expect(sourceHash()).toBe(sourceHash());
  });
});

describe.skipIf(process.platform === "win32")(
  "Docker not running (spec: release-qa › Docker not running)",
  () => {
    it("qa:up explains and does nothing else", () => {
      const dir = mkdtempSync(join(tmpdir(), "fake-docker-"));
      const log = join(dir, "calls.log");
      writeFileSync(join(dir, "docker"), `#!/bin/sh\necho "$@" >> "${log}"\nexit 1\n`);
      chmodSync(join(dir, "docker"), 0o755);
      const r = spawnSync("pnpm", ["exec", "tsx", "scripts/qa-up.ts"], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` },
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("Docker is not reachable");
      expect(readFileSync(log, "utf8").trim()).toBe("info"); // no compose, no certificate step
    });
  },
);

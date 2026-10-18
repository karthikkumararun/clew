// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const run = (...args: string[]) =>
  spawnSync("pnpm", ["exec", "tsx", "scripts/release/cli.ts", ...args], { encoding: "utf8" });

describe("release cli › meta", () => {
  const version = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;

  it("--from-files (the dry run) reports the version the files agree on", () => {
    const r = run("meta", "--from-files");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`version=${version}`);
    expect(r.stdout).toContain(`tag=v${version}`);
    expect(r.stdout).toContain("prerelease=false");
  });

  it("a tag that does not match the files fails", () => {
    expect(run("meta", "v99.0.0").status).not.toBe(0);
  });

  it("is not a no-op: the workflow's check relies on the exit status", () => {
    expect(() =>
      execFileSync("pnpm", ["exec", "tsx", "scripts/release/cli.ts", "meta", "nonsense"], {
        stdio: "ignore",
      }),
    ).toThrow();
  });
});

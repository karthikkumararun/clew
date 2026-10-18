// @vitest-environment node
// Guards .github/workflows/homebrew.yml (spec: homebrew-packaging › Release
// automation for the tap): when a release is published, stable releases only, skipped without the token, one
// file pushed. The workflow itself cannot run locally, so its shape is asserted here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Job {
  needs?: string | string[];
  if?: string;
  steps: { name?: string; if?: string; run?: string; env?: Record<string, string> }[];
}
const read = (f: string) => readFileSync(join(process.cwd(), ".github/workflows", f), "utf8");
const jobs = (parse(read("release.yml")) as { jobs: Record<string, Job> }).jobs;
const tapWorkflow = parse(read("homebrew.yml")) as {
  on: { release: { types: string[] }; workflow_dispatch: unknown };
  jobs: Record<string, Job>;
};
const home = tapWorkflow.jobs.homebrew;
const script = home.steps.map((s) => s.run ?? "").join("\n");

describe("homebrew workflow", () => {
  it("runs when a release is published, not when the draft is created", () => {
    expect(tapWorkflow.on.release.types).toEqual(["published"]);
    expect(tapWorkflow.on.workflow_dispatch).toBeTruthy();
    expect(jobs.homebrew).toBeUndefined();
    expect(script).toContain("isPrerelease");
  });

  it("skips quietly without the token: every later step checks the token output", () => {
    const names = ["Download", "Render", "Gate", "Push"];
    for (const n of names) {
      const step = home.steps.find((s) => s.name?.startsWith(n));
      expect(step?.if, n).toBe("steps.token.outputs.enabled == 'true'");
    }
    expect(script).toContain("HOMEBREW_TAP_TOKEN is not configured");
  });

  it("runs the download and the signed-flag read as two commands, not one folded line", () => {
    const step = home.steps.find((s) => s.name?.startsWith("Download"));
    const lines = (step?.run ?? "").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^gh release download/);
    expect(lines[1]).toMatch(/^echo "SIGNED_MACOS=/);
  });

  it("gates the cask before pushing", () => {
    const order = ["brew style", "brew audit --cask --online --strict", "brew install --cask"].map(
      (c) => script.indexOf(c),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(script.indexOf("push origin")).toBeGreaterThan(script.indexOf("brew uninstall"));
    expect(script).toContain("com.apple.quarantine");
    expect(script).toContain("--version");
  });

  it("pushes a single commit that touches only Casks/clew.rb", () => {
    expect(script).toContain('commit -q -m "clew $VERSION"');
    expect(script).toContain('[ "$changed" != "Casks/clew.rb" ]');
    expect(script.match(/git add /g)).toHaveLength(1);
  });

  it("keeps the job token read-only and the tap token to the push step", () => {
    const withToken = home.steps.filter((s) => s.env && "HOMEBREW_TAP_TOKEN" in s.env);
    expect(withToken.map((s) => s.name)).toEqual([
      "Check the tap token",
      "Push the cask to the tap",
    ]);
  });

  it("learns whether the build was signed from the release itself", () => {
    expect(script).toContain("BUILD_SIGNED_MACOS.txt");
    const publish = jobs.publish.steps.map((s) => s.run ?? "").join("\n");
    expect(publish).toContain("BUILD_SIGNED_MACOS.txt");
  });
});

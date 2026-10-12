import { browser } from "@wdio/globals";
import { launchApp, waitForShell } from "../helpers/app";
import { describeViolations, seriousViolations } from "../helpers/a11y";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import { regionProblems } from "../helpers/metrics";
import { overlayProblems } from "../helpers/overlay";

// D-04 the design checks fail for the defects they exist to catch. Each test injects a fixture
// defect into the live page, expects the matching check to report it, and removes the fixture
// (see the scenarios named in each test title).
describe("D-04 the checks catch defects", () => {
  const data = withDataDir();

  before(async () => {
    await waitForShell();
    await launchApp(data);
    await browser.setWindowSize(1440, 900);
  });

  afterEach(async () => {
    await browser.execute(() => document.querySelectorAll("[data-fixture]").forEach((e) => e.remove()));
  });

  it(`flags a menu clipped by an overflow:hidden ancestor ${covers("design-conformance › Clipped menu is caught")}`, async () => {
    await browser.execute(() => {
      const bar = document.createElement("div");
      bar.dataset.fixture = "1";
      bar.style.cssText = "position:fixed;top:60px;left:40px;width:120px;height:24px;overflow:hidden;background:#222";
      const menu = document.createElement("div");
      menu.id = "fixture-menu";
      menu.setAttribute("role", "menu");
      menu.style.cssText = "position:absolute;top:20px;left:0;width:200px;height:160px;background:#444";
      bar.appendChild(menu);
      document.body.appendChild(bar);
    });
    const problems = await overlayProblems("#fixture-menu");
    if (!problems.some((p) => p.includes("clipped by <div")))
      throw new Error(`expected a clipping problem, got: ${problems.join("; ") || "none"}`);
  });

  it("flags a menu that leaves the window", async () => {
    await browser.execute(() => {
      const menu = document.createElement("div");
      menu.dataset.fixture = "1";
      menu.id = "fixture-menu";
      menu.style.cssText = "position:fixed;top:10px;right:-60px;width:200px;height:100px;background:#444";
      document.body.appendChild(menu);
    });
    const problems = await overlayProblems("#fixture-menu");
    if (!problems.some((p) => p.includes("leaves the"))) throw new Error(`got: ${problems.join("; ") || "none"}`);
  });

  it(`flags a region 6px off its metric and names it ${covers("design-conformance › Metric drift")}`, async () => {
    await browser.execute(() => {
      const el = document.createElement("div");
      el.dataset.fixture = "1";
      el.dataset.metric = "status-bar";
      el.style.cssText = "position:fixed;bottom:100px;left:0;width:50px;height:32px"; // the status bar is 26px
      document.body.appendChild(el);
    });
    const problems = await regionProblems("status-bar");
    if (!problems.some((p) => p.includes("status-bar: expected height 26px, measured 32px")))
      throw new Error(`got: ${problems.join("; ") || "none"}`);
  });

  it(`flags an icon-only button without an accessible name ${covers("design-conformance › Missing accessible name")}`, async () => {
    await browser.execute(() => {
      const b = document.createElement("button");
      b.dataset.fixture = "1";
      b.id = "fixture-icon-button";
      b.innerHTML = '<svg width="12" height="12"><circle cx="6" cy="6" r="5"/></svg>';
      document.body.appendChild(b);
    });
    const v = await seriousViolations();
    if (!v.some((x) => x.nodes.some((n) => n.includes("fixture-icon-button"))))
      throw new Error(`the button without a name was not reported: ${describeViolations(v) || "no violations"}`);
  });
});

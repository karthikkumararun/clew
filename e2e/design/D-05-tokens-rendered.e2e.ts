import { $, browser } from "@wdio/globals";
import { launchApp, waitForShell } from "../helpers/app";
import { connectionFactory, seedConnections } from "../helpers/connections";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import { Explorer } from "../pages/Explorer";

// D-05 environment-coded elements resolve to their tokens in the real app
// (spec: design-conformance › Production badge colours).
describe("D-05 tokens as rendered", () => {
  const data = withDataDir();

  before(async () => {
    seedConnections(data.dir, [connectionFactory.sqlite("prod-lite", `${data.dir}/p.db`, "production")]);
    await waitForShell();
    await launchApp(data);
    await browser.setWindowSize(1440, 900);
    await Explorer.select("prod-lite");
    await browser.keys("Enter");
    await $("aria/SQL editor").waitForDisplayed({ timeout: 30_000 });
  });

  it(`the production badge uses the production badge tokens ${covers("design-conformance › Production badge colours")}`, async () => {
    const badge = $('.//button[starts-with(normalize-space(.), "PRODUCTION")]');
    await badge.waitForDisplayed({ timeout: 10_000 });
    const r = await browser.execute((el) => {
      const resolve = (token: string, prop: "color" | "backgroundColor") => {
        const probe = document.createElement("span");
        probe.style[prop] = `var(${token})`;
        document.body.appendChild(probe);
        const v = getComputedStyle(probe)[prop];
        probe.remove();
        return v;
      };
      const cs = getComputedStyle(el as HTMLElement);
      return {
        fg: cs.color,
        bg: cs.backgroundColor,
        wantFg: resolve("--env-prod-badge-fg", "color"),
        wantBg: resolve("--env-prod-badge-bg", "backgroundColor"),
      };
    }, await badge);
    if (r.fg !== r.wantFg) throw new Error(`badge text is ${r.fg}, --env-prod-badge-fg is ${r.wantFg}`);
    if (r.bg !== r.wantBg) throw new Error(`badge background is ${r.bg}, --env-prod-badge-bg is ${r.wantBg}`);
  });
});

// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COUNTS, DIALECTS, rows, seedSql } from "./generate";

describe("shop seed (spec: e2e-testing › Shared seed dataset)", () => {
  it.each(DIALECTS)("the committed %s.sql matches the generator", (d) => {
    const file = readFileSync(new URL(`./${d}.sql`, import.meta.url), "utf8");
    expect(file, "run: pnpm exec tsx e2e/seed/generate.ts").toBe(seedSql(d));
  });

  it("has the documented row counts and the awkward values", () => {
    const r = rows("postgres");
    expect(r.users).toHaveLength(COUNTS.users);
    expect(r.orders).toHaveLength(COUNTS.orders);
    expect(r.order_items).toHaveLength(COUNTS.order_items);
    expect(r.shipments).toHaveLength(COUNTS.shipments);
    expect(r.users.some((u) => u[2] === null)).toBe(true); // NULL email
    expect(
      r.users.some((u) =>
        String(u[1])
          .split("")
          .some((ch) => ch.charCodeAt(0) > 127),
      ),
    ).toBe(true); // Unicode
    expect(String(r.order_items[0][4]).replace(".", "")).toHaveLength(30); // 30-digit decimal
  });

  it("writes the same logical rows in every dialect (only timestamps are spelled differently)", () => {
    const strip = (d: (typeof DIALECTS)[number]) => rows(d).orders.map((o) => o.slice(0, 5));
    for (const d of DIALECTS) expect(strip(d)).toEqual(strip("postgres"));
  });
});

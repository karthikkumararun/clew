import { describe, expect, it } from "vitest";
import { formatBytes, formatTtl, groupKeys, hexDump, line, prettyJson, quote } from "./format";
import type { KeyInfo } from "./api";

const k = (name: string, type_name = "string"): KeyInfo => ({ name, type_name, ttl_ms: null });

describe("groupKeys", () => {
  it("groups by the part before the first colon", () => {
    const g = groupKeys([
      k("session:2", "hash"),
      k("session:1", "hash"),
      k("rate:ip:1.2.3.4"),
      k("queue"),
      k(":odd"),
    ]);
    expect(g.groups.map((x) => [x.label, x.keys.length])).toEqual([
      ["rate:*", 1],
      ["session:*", 2],
    ]);
    expect(g.groups[1].keys.map((x) => x.name)).toEqual(["session:1", "session:2"]);
    expect(g.plain.map((x) => x.name)).toEqual([":odd", "queue"]);
  });
});

describe("quote", () => {
  it("escapes what the console tokenizer reads back", () => {
    expect(quote("plain")).toBe('"plain"');
    expect(quote('say "hi"\n\\')).toBe('"say \\"hi\\"\\n\\\\"');
    expect(quote("a\u0001b")).toBe('"a\\x01b"');
    expect(quote("héllo ✓")).toBe('"héllo ✓"');
    expect(line("HSET", "session:42", "plan", "pro max")).toBe(
      'HSET "session:42" "plan" "pro max"',
    );
  });
});

describe("formatting", () => {
  it("shows TTLs in the two biggest units", () => {
    expect(formatTtl(null)).toBe("no expiry");
    expect(formatTtl(250)).toBe("250 ms");
    expect(formatTtl(45_000)).toBe("45s");
    expect(formatTtl(303_000)).toBe("5m 3s");
    expect(formatTtl(3_600_000)).toBe("1h");
    expect(formatTtl(2 * 86_400_000 + 4 * 3_600_000 + 5000)).toBe("2d 4h");
  });

  it("shows sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1048576)).toBe("3.0 MB");
  });

  it("pretty-prints JSON only when it is JSON", () => {
    expect(prettyJson('{"a":1,"b":[true]}')).toBe('{\n  "a": 1,\n  "b": [\n    true\n  ]\n}');
    expect(prettyJson("hello")).toBeNull();
    expect(prettyJson("{broken")).toBeNull();
    expect(prettyJson("")).toBeNull();
  });

  it("dumps hex with an ASCII column", () => {
    expect(hexDump("Hi!\n")).toBe(`00000000  48 69 21 0a${" ".repeat(47 - 11)}  Hi!.`);
  });
});

/** Contract: Display as codec, Highlight as and Load / Save pure-part tests. */
import { describe, expect, it } from "vitest";
import type { Value } from "../../../lib/ipc/drivers";
import { NULL, dec, flt, int, text } from "./testing";
import {
  bytesToHex,
  decode,
  defaultDisplay,
  defaultHighlight,
  displayModesFor,
  editThroughDisplay,
  encode,
  formatSize,
  needsFullFetch,
  roundTrips,
  suggestFileName,
  valueFromFileBytes,
  valueToFileBytes,
} from "./valueCodec";

const bytes = (hex: string): Value => ({ kind: "bytes", value: hex, len: hex.length / 2 });
const UUID_HEX = "123e4567e89b12d3a456426614174000";
const ts = (value: string): Value => ({ kind: "timestamptz", value });

describe("Display as: bytes", () => {
  it("shows a 16-byte binary cell as UUID and leaves the stored bytes alone (spec: data-grid › Binary as UUID)", () => {
    const v = bytes(UUID_HEX);
    expect(displayModesFor("bytes")).toEqual(["hex", "text", "base64", "uuid"]);
    expect(decode(v, "uuid")).toEqual({ ok: true, text: "123e4567-e89b-12d3-a456-426614174000" });
    expect(v).toEqual(bytes(UUID_HEX)); // never mutated
    // unchanged display text keeps the original value object
    const same = editThroughDisplay(v, "123e4567-e89b-12d3-a456-426614174000", "uuid", "bytes");
    expect(same).toEqual({ ok: true, value: v, changed: false });
    // editing through the UUID form writes the 16 bytes
    const edited = editThroughDisplay(v, "{123E4567-E89B-12D3-A456-426614174001}", "uuid", "bytes");
    expect(edited).toEqual({
      ok: true,
      value: bytes("123e4567e89b12d3a456426614174001"),
      changed: true,
    });
  });

  it("round-trips hex, base64 and text, and rejects bad input with a reason", () => {
    const hello = bytes("68656c6c6f");
    for (const d of ["hex", "text", "base64"] as const) {
      expect(roundTrips(hello, d)).toEqual({ ok: true });
      const shown = decode(hello, d);
      expect(shown.ok && encode(shown.text, d, "bytes")).toEqual({ ok: true, value: hello });
    }
    expect(decode(hello, "base64")).toEqual({ ok: true, text: "aGVsbG8=" });
    expect(encode("0xDE AD", "hex", "bytes")).toEqual({ ok: true, value: bytes("dead") });
    expect(encode("abc", "hex", "bytes")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("even"),
    });
    expect(encode("zz", "hex", "bytes")).toMatchObject({ ok: false });
    expect(encode("aGVsbG8", "base64", "bytes")).toMatchObject({ ok: false });
    expect(encode("123", "uuid", "bytes")).toMatchObject({ ok: false });
    expect(decode(bytes("ff00"), "text")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("UTF-8"),
    });
    expect(decode(bytes("abcd"), "uuid")).toMatchObject({ ok: false });
    expect(roundTrips(bytes("ff00"), "text")).toMatchObject({ ok: false });
  });

  it("encodes text as UTF-8 bytes and keeps multibyte characters", () => {
    expect(encode("é", "text", "bytes")).toEqual({ ok: true, value: bytes("c3a9") });
    expect(defaultDisplay("bytes")).toBe("hex");
  });

  it("flags truncated values and refuses to edit them", () => {
    const cut: Value = { kind: "bytes", value: "6162", len: 5_000_000, truncated: true };
    expect(decode(cut, "hex")).toMatchObject({ ok: true, truncated: true });
    expect(needsFullFetch(cut)).toBe(true);
    expect(needsFullFetch(bytes("00"))).toBe(false);
    expect(editThroughDisplay(cut, "61", "hex", "bytes")).toMatchObject({ ok: false });
  });
});

describe("Display as: numbers", () => {
  it("groups and ungroups without floating point", () => {
    const d = dec("1234567.890");
    expect(decode(d, "grouped")).toEqual({ ok: true, text: "1,234,567.890" });
    expect(roundTrips(d, "grouped")).toEqual({ ok: true });
    expect(encode("1,234,567.89", "grouped", "decimal")).toEqual({
      ok: true,
      value: dec("1234567.89"),
    });
    expect(decode({ kind: "bigint", value: "9007199254740993" }, "grouped")).toEqual({
      ok: true,
      text: "9,007,199,254,740,993",
    });
    expect(decode(int(-1500), "grouped")).toEqual({ ok: true, text: "-1,500" });
  });

  it("rejects an ambiguous comma", () => {
    expect(encode("1,45", "grouped", "decimal")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("ambiguous"),
    });
    expect(encode("1,234", "default", "int")).toMatchObject({ ok: false });
    expect(editThroughDisplay(dec("1.5"), "1,5", "grouped", "decimal")).toMatchObject({
      ok: false,
    });
  });

  it("validates per kind", () => {
    expect(encode("12.5", "default", "int")).toMatchObject({ ok: false });
    expect(encode("12", "default", "int")).toEqual({ ok: true, value: int(12) });
    expect(encode("99999999999999999999", "default", "int")).toMatchObject({ ok: false });
    expect(encode("99999999999999999999", "default", "bigint")).toEqual({
      ok: true,
      value: { kind: "bigint", value: "99999999999999999999" },
    });
    expect(encode("1e3", "default", "decimal")).toEqual({ ok: true, value: dec("1000") });
    expect(encode("abc", "default", "float")).toMatchObject({ ok: false });
    expect(encode("", "default", "int")).toMatchObject({ ok: false });
    expect(decode(flt(12345.5), "scientific")).toEqual({ ok: true, text: "1.23455e+4" });
    expect(decode(dec("1"), "scientific")).toMatchObject({ ok: false });
    expect(displayModesFor("float")).toContain("scientific");
    expect(displayModesFor("decimal")).not.toContain("scientific");
  });
});

describe("Display as: JSON and dates", () => {
  it("formats JSON pretty or compact and round-trips json columns", () => {
    const j: Value = { kind: "json", value: { a: 1, b: [true, null] } };
    expect(decode(j, "json-compact")).toEqual({ ok: true, text: '{"a":1,"b":[true,null]}' });
    expect((decode(j, "json-pretty") as { text: string }).text).toContain('\n  "a": 1');
    expect(roundTrips(j, "json-pretty")).toEqual({ ok: true });
    expect(roundTrips(j, "json-compact")).toEqual({ ok: true });
    expect(editThroughDisplay(j, '{"a": 2}', "json-compact", "json")).toEqual({
      ok: true,
      value: { kind: "json", value: { a: 2 } },
      changed: true,
    });
    expect(editThroughDisplay(j, "{oops", "json-pretty", "json")).toMatchObject({ ok: false });
  });

  it("rejects JSON text that would be rewritten and non-JSON text", () => {
    const compact = text('{"a":1}');
    expect(decode(compact, "json-pretty")).toEqual({ ok: true, text: '{\n  "a": 1\n}' });
    expect(roundTrips(compact, "json-pretty")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("rewrite"),
    });
    expect(roundTrips(compact, "json-compact")).toEqual({ ok: true });
    expect(decode(text("not json"), "json-pretty")).toMatchObject({ ok: false });
  });

  it("converts timestamps between formats and back", () => {
    const v = ts("2024-01-05 10:30:00+00");
    expect(decode(v, "iso8601")).toEqual({ ok: true, text: "2024-01-05T10:30:00+00:00" });
    expect(decode(v, "us")).toEqual({ ok: true, text: "01/05/2024 10:30:00 +00:00" });
    expect(decode(v, "eu")).toEqual({ ok: true, text: "05.01.2024 10:30:00 +00:00" });
    expect(decode(v, "epoch-s")).toEqual({ ok: true, text: "1704450600" });
    expect(decode(v, "epoch-ms")).toEqual({ ok: true, text: "1704450600000" });
    expect(encode("1704450600", "epoch-s", "timestamptz")).toEqual({
      ok: true,
      value: ts("2024-01-05 10:30:00+00:00"),
    });
    expect(encode("01/05/2024 10:30:00 +00:00", "us", "timestamptz")).toEqual({
      ok: true,
      value: ts("2024-01-05 10:30:00+00:00"),
    });
    const shown = decode(v, "us");
    expect(shown.ok && editThroughDisplay(v, shown.text, "us", "timestamptz")).toEqual({
      ok: true,
      value: v,
      changed: false,
    });
    expect(editThroughDisplay(v, "01/06/2024 10:30:00 +00:00", "us", "timestamptz")).toMatchObject({
      ok: true,
      changed: true,
    });
    // dates
    expect(decode({ kind: "date", value: "2024-01-05" }, "eu")).toEqual({
      ok: true,
      text: "05.01.2024",
    });
    expect(encode("05.01.2024", "eu", "date")).toEqual({
      ok: true,
      value: { kind: "date", value: "2024-01-05" },
    });
  });

  it("rejects dates that do not exist, wrong shapes and lossy epochs", () => {
    expect(encode("02/30/2024", "us", "date")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not a real date"),
    });
    expect(encode("13/01/2024", "us", "date")).toMatchObject({ ok: false });
    expect(encode("2024-01-05", "us", "date")).toMatchObject({ ok: false });
    expect(encode("2024-01-05 10:00:00", "iso8601", "date")).toMatchObject({ ok: false });
    expect(decode(ts("2024-01-05 10:30:00.5+00"), "epoch-s")).toMatchObject({ ok: false });
    expect(decode(ts("2024-01-05 10:30:00.123456+00"), "epoch-ms")).toMatchObject({ ok: false });
    expect(decode(ts("2024-01-05 10:30:00.5+00"), "epoch-ms")).toEqual({
      ok: true,
      text: "1704450600500",
    });
  });
});

describe("Highlight as and file helpers", () => {
  it("picks a default language and exposes CodeMirror packages", () => {
    expect(defaultHighlight("json")).toBe("json");
    expect(defaultHighlight("text", '{"a":1}')).toBe("json");
    expect(defaultHighlight("text", "<?xml version='1.0'?><a/>")).toBe("xml");
    expect(defaultHighlight("text", "hello")).toBe("plain");
    expect(defaultHighlight("int")).toBe("plain");
  });

  it("writes the full value of a large text cell (spec: data-grid › Save a large value)", () => {
    const big = "x".repeat(5 * 1024 * 1024);
    const truncated: Value = { kind: "text", value: big.slice(0, 1000), truncated: true };
    expect(needsFullFetch(truncated)).toBe(true);
    const full: Value = { kind: "text", value: big };
    expect(needsFullFetch(full)).toBe(false);
    expect(valueToFileBytes(full)?.length).toBe(5 * 1024 * 1024);
    expect(valueToFileBytes(bytes("00ff"))).toEqual(new Uint8Array([0, 255]));
    expect(valueToFileBytes(NULL)).toBeNull();
    expect(
      suggestFileName({ column: "notes", kind: "text", display: "default", highlight: "plain" }),
    ).toMatchObject({ name: "notes.txt", extension: "txt" });
  });

  it("suggests names by display mode and sanitises the column name", () => {
    expect(suggestFileName({ column: "payload", kind: "bytes", display: "hex" }).name).toBe(
      "payload.hex",
    );
    expect(suggestFileName({ column: "payload", kind: "bytes", display: "base64" }).name).toBe(
      "payload.b64",
    );
    expect(suggestFileName({ column: "blob", kind: "bytes", display: "default" }).name).toBe(
      "blob.bin",
    );
    expect(suggestFileName({ column: "doc", kind: "json", display: "json-pretty" }).name).toBe(
      "doc.json",
    );
    expect(
      suggestFileName({ column: "q", kind: "text", display: "default", highlight: "sql" }).name,
    ).toBe("q.sql");
    expect(suggestFileName({ column: "a/b:c", kind: "text", display: "default" }).name).toBe(
      "a_b_c.txt",
    );
    expect(
      suggestFileName({ column: "doc", kind: "json", display: "json-pretty" }).filters[1],
    ).toEqual({ name: "All files", extensions: ["*"] });
  });

  it("turns a loaded file into a cell value with its size (spec: data-grid › Load a file)", () => {
    const file = new Uint8Array(2 * 1024 * 1024).fill(7);
    const r = valueFromFileBytes(file, "bytes");
    expect(r.ok && r.value.kind === "bytes" && r.value.len).toBe(2 * 1024 * 1024);
    expect(r.ok && r.value.kind === "bytes" && r.value.value.slice(0, 4)).toBe("0707");
    expect(formatSize(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(formatSize(512)).toBe("512 B");
    expect(valueFromFileBytes(new TextEncoder().encode("héllo"), "text")).toEqual({
      ok: true,
      value: text("héllo"),
    });
    expect(valueFromFileBytes(new Uint8Array([0xff, 0xfe]), "text")).toMatchObject({ ok: false });
    expect(valueFromFileBytes(new TextEncoder().encode('{"a":1}'), "json")).toMatchObject({
      ok: true,
    });
    expect(valueFromFileBytes(new TextEncoder().encode("{x"), "json")).toMatchObject({ ok: false });
    expect(valueFromFileBytes(new Uint8Array([1]), "int")).toMatchObject({ ok: false });
    expect(bytesToHex(new Uint8Array([1, 171]))).toBe("01ab");
  });
});

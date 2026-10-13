import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { splitStatements } from "../../console/editor/statements";
import type { GraphSchema } from "../types";
import { cypherSource, cypherSuggestions } from "./completion";
import { StringStream } from "@codemirror/language";
import { cypherLanguage, token } from "./language";
import { missingParam, missingParamMessage, parseParams, usedParams } from "./params";

const schema: GraphSchema = {
  labels: [
    { name: "User", count: 8100 },
    { name: "Product", count: 3900 },
    { name: "Category", count: 42 },
  ],
  relationshipTypes: [
    { name: "PURCHASED", count: 120000 },
    { name: "FOLLOWS", count: 900 },
  ],
  propertyKeys: ["name", "email", "plan"],
  indexes: [],
  constraints: [],
};

const labels = (before: string) =>
  cypherSuggestions({ before, schema, params: [] })?.options.map((o) => o.label);

describe("Cypher completion (spec: graph-browser › Cypher editor)", () => {
  it("offers the label with its node count after `(u:Us` (spec: graph-browser › Complete a label)", () => {
    const found = cypherSuggestions({ before: "MATCH (u:Us", schema, params: [] });
    expect(found?.from).toBe("MATCH (u:".length);
    const user = found?.options.find((o) => o.label === "User");
    expect(user?.detail).toBe("8.1k");
    expect(found?.options.map((o) => o.label)).toEqual(["User", "Product", "Category"]);
  });

  it("keeps offering labels after a second colon and in a label predicate", () => {
    expect(labels("MATCH (u:User:Pr")).toContain("Product");
    expect(labels("MATCH (u) WHERE u:Ca")).toContain("Category");
  });

  it("offers relationship types inside brackets, with counts", () => {
    const found = cypherSuggestions({ before: "MATCH (a)-[r:PU", schema, params: [] });
    expect(found?.options.map((o) => [o.label, o.detail])).toEqual([
      ["PURCHASED", "120.0k"],
      ["FOLLOWS", "900"],
    ]);
  });

  it("offers property keys after `n.` and inside a pattern map, but not at a map value", () => {
    expect(labels("MATCH (n) RETURN n.na")).toEqual(["name", "email", "plan"]);
    expect(labels("MATCH (n:User {na")).toEqual(["name", "email", "plan"]);
    expect(labels("MATCH (n:User {name: ")).toBeUndefined();
  });

  it("offers the parameters of the panel after `$`", () => {
    const found = cypherSuggestions({
      before: "WHERE n.name = $",
      schema,
      params: ["name", "age"],
    });
    expect(found?.options.map((o) => o.label)).toEqual(["name", "age"]);
  });

  it("offers procedures after CALL and keywords with functions elsewhere", () => {
    expect(labels("CALL db.")).toContain("db.labels");
    const all = labels("MA") ?? [];
    expect(all).toContain("MATCH");
    expect(all).toContain("count");
  });

  it("offers nothing in strings or comments, or on an empty word", () => {
    expect(labels("MATCH (n {name: 'ab")).toBeUndefined();
    expect(labels("// users:")).toBeUndefined();
    expect(labels("MATCH ")).toBeUndefined();
  });

  it("works as a CodeMirror source for the statement under the cursor", () => {
    const doc = "RETURN 1;\nMATCH (u:Us";
    const state = EditorState.create({ doc });
    const source = cypherSource({ schema: () => schema, params: () => [] });
    const result = source(new CompletionContext(state, doc.length, false));
    expect(result?.from).toBe(doc.length - 2);
    const user = result?.options.find((o) => o.label === "User");
    expect(user?.detail).toBe("8.1k");
  });
});

describe("parameters (spec: graph-browser › Missing parameter)", () => {
  it("finds $names outside strings and comments", () => {
    expect(
      usedParams("MATCH (n {name: $name}) // $ignored\nWHERE n.x = '$no' AND n.y = $age AND $name"),
    ).toEqual(["name", "age"]);
  });

  it("reports the first parameter without a value", () => {
    expect(missingParam("RETURN $a, $b", { a: 1 })).toBe("b");
    expect(missingParam("RETURN $a", { a: null })).toBeNull();
    expect(missingParamMessage("name")).toBe("Set a value for $name");
  });

  it("parses the panel as a JSON object", () => {
    expect(parseParams("")).toEqual({ ok: true, value: {} });
    expect(parseParams('{"a": 1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseParams("[1]")).toMatchObject({ ok: false });
    expect(parseParams("{oops")).toMatchObject({ ok: false });
  });
});

describe("Cypher statements and highlighting", () => {
  it("splits on `;` and treats `--` as a relationship, `//` as a comment", () => {
    const text = "MATCH (a)--(b) RETURN a; // done; really\nRETURN ';' AS s;";
    expect(splitStatements(text, "cypher").map((r) => r.text)).toEqual([
      "MATCH (a)--(b) RETURN a",
      "// done; really\nRETURN ';' AS s",
    ]);
  });

  it("tokenizes keywords, labels, map keys, functions, parameters and comments", () => {
    const tokens = (line: string) => {
      const state = { stack: [] as string[], label: false, block: false };
      const stream = new StringStream(line, 2, 2);
      const out: [string, string | null][] = [];
      while (!stream.eol()) {
        stream.start = stream.pos;
        const kind = token(stream, state);
        if (kind) out.push([stream.current(), kind]);
      }
      return out;
    };
    expect(tokens("MATCH (u:User {name: $n}) RETURN count(u) // x")).toEqual([
      ["MATCH", "keyword"],
      ["(", "paren"],
      ["u", "variableName"],
      [":", "punctuation"],
      ["User", "typeName"],
      ["{", "paren"],
      ["name", "variableName"],
      [":", "punctuation"],
      ["$n", "variableName.special"],
      ["}", "paren"],
      [")", "paren"],
      ["RETURN", "keyword"],
      ["count", "function"],
      ["(", "paren"],
      ["u", "variableName"],
      [")", "paren"],
      ["// x", "lineComment"],
    ]);
    expect(tokens("(a)-[:BOUGHT|SOLD]->(b) 'it''s' 12.5")).toContainEqual(["SOLD", "typeName"]);
  });

  it("builds the language extension", () => {
    expect(cypherLanguage()).toBeTruthy();
  });
});

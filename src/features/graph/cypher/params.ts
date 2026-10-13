/** Query parameters (`$name`): which a statement uses, and the Parameters panel's JSON. */

/** Names of the `$parameters` a statement uses, outside strings and comments, in order. */
export function usedParams(cypher: string): string[] {
  const names: string[] = [];
  const n = cypher.length;
  let i = 0;
  while (i < n) {
    const c = cypher[i];
    if (c === "'" || c === '"' || c === "`") {
      i += 1;
      while (i < n && cypher[i] !== c) i += cypher[i] === "\\" ? 2 : 1;
      i += 1;
    } else if (c === "/" && cypher[i + 1] === "/") {
      const nl = cypher.indexOf("\n", i);
      i = nl < 0 ? n : nl + 1;
    } else if (c === "/" && cypher[i + 1] === "*") {
      const end = cypher.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === "$") {
      const m = /^(?:[A-Za-z_][\w]*|\d+)/.exec(cypher.slice(i + 1));
      if (m) {
        if (!names.includes(m[0])) names.push(m[0]);
        i += 1 + m[0].length;
      } else i += 1;
    } else i += 1;
  }
  return names;
}

export type ParsedParams =
  { ok: true; value: Record<string, unknown> } | { ok: false; message: string };

/** The Parameters panel text as an object. Empty text means no parameters. */
export function parseParams(text: string): ParsedParams {
  if (text.trim() === "") return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, message: `Parameters must be valid JSON: ${(e as Error).message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: 'Parameters must be a JSON object, e.g. {"name": "Ada"}' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** The first `$parameter` the statement uses that has no value, or `null`. */
export function missingParam(cypher: string, params: Record<string, unknown>): string | null {
  return usedParams(cypher).find((n) => !(n in params)) ?? null;
}

export const missingParamMessage = (name: string) => `Set a value for $${name}`;

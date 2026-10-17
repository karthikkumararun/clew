/**
 * Fuzzy matching for the palette's queries and actions (spec: command-palette › Fuzzy search).
 * Objects are scored in Rust with nucleo; this applies the same rules in JS: every query
 * character must appear in order, and exact prefixes outrank word-boundary matches, which outrank
 * the rest.
 */
export interface Match {
  score: number;
  /** Positions of the matched characters in the text. */
  indices: number[];
}

const BOUNDARY = /[\s_.\-/:]/;

function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  if (BOUNDARY.test(prev)) return true;
  // camelCase step: lower → upper.
  return (
    prev === prev.toLowerCase() && prev !== prev.toUpperCase() && text[i] !== text[i].toLowerCase()
  );
}

/** Match `query` against `text`, case-insensitively; `null` when it doesn't match. */
export function fuzzyMatch(query: string, text: string): Match | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();
  // Forward scan finds an end, a backward scan tightens the start.
  let qi = 0;
  let end = -1;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      qi++;
      if (qi === q.length) end = i;
    }
  }
  if (qi < q.length) return null;
  const indices: number[] = [];
  qi = q.length - 1;
  for (let i = end; i >= 0 && qi >= 0; i--) {
    if (t[i] === q[qi]) {
      indices.unshift(i);
      qi--;
    }
  }
  let score = 0;
  indices.forEach((pos, k) => {
    score += 10;
    if (isBoundary(text, pos)) score += 8;
    if (k > 0 && pos === indices[k - 1] + 1) score += 6;
    if (k > 0) score -= Math.min(5, pos - indices[k - 1] - 1);
  });
  if (t.startsWith(q)) score += 1000;
  else if (t.split(BOUNDARY).some((w) => w.startsWith(q))) score += 500;
  // Shorter texts win ties.
  score -= Math.min(50, text.length / 4);
  return { score, indices };
}

/** Split `text` into runs, marking the characters at `indices`. */
export function highlightRuns(
  text: string,
  indices: readonly number[],
): { text: string; hit: boolean }[] {
  if (indices.length === 0) return [{ text, hit: false }];
  const set = new Set(indices);
  const runs: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    const last = runs[runs.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else runs.push({ text: text[i], hit });
  }
  return runs;
}

// Pure helpers for scripts/qa-e2e.ts: suite selection, retry bookkeeping, the flaky summary and
// the quarantine list (spec: e2e-testing › Suites and triggers; Flake policy).
export interface Suites {
  /** Journey ids (the "J-03" part of the file name) that need no containers. */
  smoke: string[];
  /** Journey ids that need the heavy Docker profile or Neo4j. */
  heavy: string[];
  /** Journeys that run the app against the real OS keychain (test service name). */
  keychain?: string[];
  /** Compose profiles a journey needs when it runs against containers. */
  needs?: Record<string, string[]>;
}

export interface QuarantineEntry {
  journey: string;
  issue: number | string;
  since: string;
}

export type SuiteName = "smoke" | "full" | "heavy" | "design";

export const journeyId = (file: string) => /^([JD]-\d+)/.exec(file)?.[1] ?? file;

export function selectJourneys(
  files: string[],
  suites: Suites,
  suite: SuiteName | undefined,
  filters: string[] = [],
): string[] {
  const inList = (file: string, ids: string[]) => ids.includes(journeyId(file));
  return files
    .filter((f) => {
      if (suite === "smoke") return inList(f, suites.smoke);
      if (suite === "heavy") return inList(f, suites.heavy);
      if (suite === "full") return !inList(f, suites.heavy);
      if (suite === "design") return true;
      return true;
    })
    .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)))
    .sort();
}

export interface JourneyResult {
  file: string;
  /** One entry per attempt: true = passed. */
  attempts: boolean[];
  seconds: number;
  quarantined: boolean;
}

export const passed = (r: JourneyResult) => r.attempts[r.attempts.length - 1] === true;
/** Failed at least once, then passed on a retry. */
export const flaky = (r: JourneyResult) => passed(r) && r.attempts.some((a) => !a);

/** A quarantined journey is reported but never fails the run. */
export function blockingFailures(results: JourneyResult[]): JourneyResult[] {
  return results.filter((r) => !passed(r) && !r.quarantined);
}

export function summaryMarkdown(suite: string, results: JourneyResult[]): string {
  const rows = results.map((r) => {
    const status = !passed(r)
      ? r.quarantined
        ? "FAIL (quarantined, not blocking)"
        : "FAIL"
      : flaky(r)
        ? "PASS (flaky: passed on retry)"
        : "PASS";
    return `| ${r.file} | ${status} | ${r.attempts.length} | ${r.seconds}s |`;
  });
  const flakyList = results.filter(flaky).map((r) => `- ${journeyId(r.file)} (${r.file})`);
  return [
    `## e2e ${suite}`,
    "",
    "| Journey | Result | Attempts | Time |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    flakyList.length ? `### Flaky\n${flakyList.join("\n")}\n` : "No flaky journeys.\n",
  ].join("\n");
}

/** Flaky reports (one per run) in a window; a journey flagged `threshold` times is due for quarantine. */
export interface FlakyReport {
  runId: string;
  at: string;
  flaky: string[];
}

export function dueForQuarantine(
  reports: FlakyReport[],
  quarantined: QuarantineEntry[],
  now: Date,
  windowDays = 14,
  threshold = 3,
): string[] {
  const since = now.getTime() - windowDays * 86_400_000;
  const counts = new Map<string, Set<string>>();
  for (const rep of reports) {
    if (new Date(rep.at).getTime() < since) continue;
    for (const j of rep.flaky) {
      const runs = counts.get(j) ?? new Set<string>();
      runs.add(rep.runId);
      counts.set(j, runs);
    }
  }
  const already = new Set(quarantined.map((q) => q.journey));
  return [...counts]
    .filter(([j, runs]) => runs.size >= threshold && !already.has(j))
    .map(([j]) => j)
    .sort();
}

/** Remove things that look like credentials before a log is written to an artifact. */
export function redact(text: string): string {
  return text
    .replace(
      /(password|passphrase|secret|token|api[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
      "$1$2[redacted]",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, "$1 [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]");
}

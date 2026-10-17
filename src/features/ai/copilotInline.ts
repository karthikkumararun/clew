import type { Suggestions } from "./inlineCompletion";

/** Completions from GitHub Copilot's language server. */
export async function copilotSuggest(_req: {
  prefix: string;
  suffix: string;
  signal: AbortSignal;
  driver: string;
}): Promise<Suggestions> {
  return { suggestions: [], provider: "Copilot" };
}

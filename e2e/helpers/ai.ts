import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MOCK_PROVIDER_ID = "custom-1";

/**
 * Switch AI on before the app starts, with one custom OpenAI-compatible endpoint (the mock LLM).
 * Writes `ai.json` and puts the token into the test-mode secret store, exactly where the app
 * reads them (spec: ai-providers).
 */
export function seedAi(
  dataDir: string,
  mock: { url: string },
  opts: { inline?: boolean; production?: "schema_only" | "disabled" | "same_as_others" } = {},
): void {
  mkdirSync(dataDir, { recursive: true });
  const settings = {
    version: 1,
    enabled: true,
    providers: [
      {
        id: MOCK_PROVIDER_ID,
        kind: "custom_openai",
        name: "Mock gateway",
        baseUrl: mock.url,
        model: "mock-model",
        auth: "bearer",
        authHeader: "",
        extraHeaders: [],
      },
    ],
    routing: {
      chat: MOCK_PROVIDER_ID,
      fix: null,
      nlSql: null,
      inline: opts.inline ? MOCK_PROVIDER_ID : null,
    },
    privacy: { schema: true, sql: true, rows: false, production: opts.production ?? "schema_only" },
    copilot: { inline: true, chat: false },
  };
  writeFileSync(join(dataDir, "ai.json"), JSON.stringify(settings));
  const file = join(dataDir, "e2e-secrets.json");
  const current = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>)
    : {};
  current[`ai:${MOCK_PROVIDER_ID}:ai-key`] = "mock-token";
  writeFileSync(file, JSON.stringify(current));
}

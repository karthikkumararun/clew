import type { ProviderConfig } from "./api";

/** A provider as the settings list shows it. */
export interface Entry {
  id: string;
  name: string;
  sub: string;
  mark: string;
  /** CSS custom property for the logo tile. */
  color: string;
}

export const COPILOT: Entry = {
  id: "copilot",
  name: "GitHub Copilot",
  sub: "Sign in with GitHub",
  mark: "GH",
  color: "var(--ai-github)",
};

export const ANTHROPIC_BASE = "https://api.anthropic.com";
export const OPENAI_BASE = "https://api.openai.com/v1";
export const LOCAL_BASE = "http://localhost:11434";
export const CLAUDE_DEFAULT_MODEL = "claude-sonnet-5-5";

export const BUILTIN: Record<string, Entry & { blurb: string }> = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic Claude",
    sub: "API key",
    mark: "AN",
    color: "var(--ai-claude)",
    blurb: "Claude models through the Anthropic API",
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    sub: "API key · GPT and Codex models",
    mark: "OA",
    color: "var(--ai-openai)",
    blurb: "GPT and Codex models through the OpenAI API",
  },
  local: {
    id: "local",
    name: "Local model",
    sub: "Ollama · LM Studio",
    mark: "LO",
    color: "var(--ai-local)",
    blurb: "Ollama or LM Studio on this machine. Nothing leaves your computer.",
  },
};

export const CUSTOM_PREFIX = "custom-";

export const isCustom = (p: Pick<ProviderConfig, "kind">) =>
  p.kind === "custom_openai" || p.kind === "custom_anthropic";

/** A new provider with the defaults of its kind. */
export function defaultProvider(id: string, existingIds: string[] = []): ProviderConfig {
  const base = { auth: "bearer" as const, authHeader: "", extraHeaders: [] };
  switch (id) {
    case "anthropic":
      return {
        ...base,
        id,
        kind: "anthropic",
        name: BUILTIN.anthropic.name,
        baseUrl: ANTHROPIC_BASE,
        model: CLAUDE_DEFAULT_MODEL,
        auth: "header",
        authHeader: "x-api-key",
      };
    case "openai":
      return {
        ...base,
        id,
        kind: "openai",
        name: BUILTIN.openai.name,
        baseUrl: OPENAI_BASE,
        model: "",
      };
    case "local":
      return {
        ...base,
        id,
        kind: "local",
        name: BUILTIN.local.name,
        baseUrl: LOCAL_BASE,
        model: "",
        auth: "none",
      };
    default: {
      let n = 1;
      while (existingIds.includes(`${CUSTOM_PREFIX}${n}`)) n++;
      return {
        ...base,
        id: id.startsWith(CUSTOM_PREFIX) ? id : `${CUSTOM_PREFIX}${n}`,
        kind: "custom_openai",
        name: "Custom endpoint",
        baseUrl: "",
        model: "",
      };
    }
  }
}

/** `http://` to anything but this machine sends a token unencrypted. */
export function isPlainHttpRemote(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]", "::1"].includes(u.hostname)
    );
  } catch {
    return false;
  }
}

/** Short model label for the composer: `claude-sonnet-5-5` → `Sonnet 5.5`. */
export function shortModel(id: string): string {
  const claude = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(id);
  if (claude) {
    const family = claude[1][0].toUpperCase() + claude[1].slice(1);
    return `${family} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  }
  return id;
}

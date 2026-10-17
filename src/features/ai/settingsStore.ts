import { create } from "zustand";
import { isTauri } from "../../lib/ipc";
import { useNotices } from "../../stores/noticesStore";
import { aiSettingsGet, aiSettingsSet } from "./api";
import type { AiSettings, ProviderConfig } from "./api";

export const EMPTY_AI_SETTINGS: AiSettings = {
  version: 1,
  enabled: false,
  providers: [],
  routing: { inline: null, chat: null, fix: null, nlSql: null },
  privacy: { schema: true, sql: true, rows: false, production: "schema_only" },
  copilot: { inline: true, chat: false },
};

interface AiSettingsState {
  settings: AiSettings;
  /** Which providers have a key or token in the keychain. */
  secrets: Record<string, boolean>;
  loaded: boolean;
  load: () => Promise<void>;
  /** Save the whole settings object; the answer replaces the state. */
  save: (next: AiSettings) => Promise<void>;
  patch: (change: Partial<AiSettings>) => Promise<void>;
  /** After a key was stored or cleared outside `save`. */
  setSecretPresent: (providerId: string, present: boolean) => void;
}

function say(message: string) {
  useNotices.getState().push(message);
}

export const useAiSettings = create<AiSettingsState>((set, get) => ({
  settings: EMPTY_AI_SETTINGS,
  secrets: {},
  loaded: false,
  load: async () => {
    if (!isTauri()) {
      set({ loaded: true });
      return;
    }
    try {
      const p = await aiSettingsGet();
      set({ settings: p.settings, secrets: p.secrets, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  save: async (next) => {
    set({ settings: next }); // optimistic; the answer is authoritative
    try {
      const p = await aiSettingsSet(next);
      set({ settings: p.settings, secrets: p.secrets });
    } catch (e) {
      say(
        `Couldn't save the AI settings: ${(e as { message?: string }).message ?? "unknown error"}`,
      );
      await get().load();
    }
  },
  patch: (change) => get().save({ ...get().settings, ...change }),
  setSecretPresent: (providerId, present) =>
    set((s) => ({ secrets: { ...s.secrets, [providerId]: present } })),
}));

/** Whether a provider can be used: it has the secret its kind needs. */
export function isConfigured(p: ProviderConfig, secrets: Record<string, boolean>): boolean {
  if (p.kind === "local" || p.auth === "none") return p.baseUrl.length > 0;
  return !!secrets[p.id];
}

/** Configured providers, in settings order. */
export function configuredProviders(): ProviderConfig[] {
  const { settings, secrets } = useAiSettings.getState();
  return settings.providers.filter((p) => isConfigured(p, secrets));
}

/** The provider the chat panel uses: the routed one, else the first configured. */
export function chatProvider(): ProviderConfig | null {
  const { settings } = useAiSettings.getState();
  const configured = configuredProviders();
  const routed = settings.routing.chat;
  return configured.find((p) => p.id === routed) ?? configured[0] ?? null;
}

import type { Extension } from "@codemirror/state";
import { useConnections } from "../../connections/connectionsStore";
import { completionTargetOf } from "../console/completionTarget";
import { aiCancel, aiComplete } from "./api";
import { completionsPaused, useCompletionState } from "./completionState";
import { copilotSuggest } from "./copilotInline";
import { useCopilot } from "./copilotStore";
import { inlineCompletion } from "./inlineCompletion";
import type { Suggestions } from "./inlineCompletion";
import { newId } from "./chatStore";
import { useAiSettings } from "./settingsStore";

/** Errors that don't count against the provider: the user changed their mind, or AI is off. */
const IGNORED = new Set(["cancelled", "ai_disabled", "ai_no_provider", "ai_disabled_production"]);

/** Whether ghost text is on for the console `tabId` right now (spec: ai-inline-completion). */
export function completionEnabled(tabId: string): boolean {
  const { settings } = useAiSettings.getState();
  if (!settings.enabled || !settings.routing.inline) return false;
  if (completionsPaused()) return false;
  const target = completionTargetOf(tabId);
  if (!target?.connected) return false;
  const conn = useConnections.getState().file.connections.find((c) => c.id === target.connectionId);
  if (!conn) return false;
  if (conn.environment === "production" && settings.privacy.production === "disabled") return false;
  if (!settings.privacy.sql) return false;
  if (settings.routing.inline === "copilot") {
    return settings.copilot.inline && useCopilot.getState().phase === "in";
  }
  return settings.providers.some((p) => p.id === settings.routing.inline);
}

/** Ask the routed provider for what comes next at the cursor. */
async function suggest(
  tabId: string,
  prefix: string,
  suffix: string,
  signal: AbortSignal,
): Promise<Suggestions> {
  const target = completionTargetOf(tabId);
  const { settings } = useAiSettings.getState();
  const route = settings.routing.inline;
  if (!target || !route) return { suggestions: [], provider: "" };
  const state = useCompletionState.getState();
  try {
    let out: Suggestions;
    if (route === "copilot") {
      out = await copilotSuggest({
        connectionId: target.connectionId,
        documentId: tabId,
        prefix,
        suffix,
        signal,
      });
    } else {
      const requestId = newId("cmp");
      const onAbort = () => void aiCancel(requestId).catch(() => {});
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const suggestions = await aiComplete({
          requestId,
          connectionId: target.connectionId,
          database: target.database,
          prefix,
          suffix,
        });
        out = {
          suggestions,
          provider: settings.providers.find((p) => p.id === route)?.name ?? "AI",
        };
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    }
    state.recordSuccess();
    return out;
  } catch (e) {
    const code = (e as { code?: string }).code ?? "";
    if (!signal.aborted && !IGNORED.has(code)) state.recordFailure();
    throw e;
  }
}

/** The ghost-text extension of a console. */
export function inlineExtensionFor(tabId: string): Extension {
  return inlineCompletion({
    enabled: () => completionEnabled(tabId),
    source: (prefix, suffix, signal) => suggest(tabId, prefix, suffix, signal),
  });
}

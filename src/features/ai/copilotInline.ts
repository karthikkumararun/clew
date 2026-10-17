import { aiCancel } from "./api";
import { newId } from "./chatStore";
import { copilotComplete } from "./copilotApi";
import type { Suggestions } from "./inlineCompletion";

/** Completions from GitHub Copilot's language server. */
export async function copilotSuggest(req: {
  connectionId: string;
  documentId: string;
  prefix: string;
  suffix: string;
  signal: AbortSignal;
}): Promise<Suggestions> {
  const requestId = newId("cop");
  const onAbort = () => void aiCancel(requestId).catch(() => {});
  req.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const suggestions = await copilotComplete({
      requestId,
      connectionId: req.connectionId,
      documentId: req.documentId,
      prefix: req.prefix,
      suffix: req.suffix,
    });
    return { suggestions, provider: "Copilot" };
  } finally {
    req.signal.removeEventListener("abort", onAbort);
  }
}

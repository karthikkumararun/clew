import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConnections } from "../../connections/connectionsStore";
import { conn } from "../explorer/testing";
import { completionsPaused, useCompletionState } from "./completionState";
import { useCopilot } from "./copilotStore";
import { completionEnabled } from "./inlineSource";
import { EMPTY_AI_SETTINGS, useAiSettings } from "./settingsStore";

const target = vi.hoisted(() => ({
  value: {
    connectionId: "c1",
    driver: "postgres",
    database: "",
    defaultSchema: "public",
    connected: true,
  } as {
    connectionId: string;
    driver: string;
    database: string;
    defaultSchema: string;
    connected: boolean;
  } | null,
}));
vi.mock("../console/completionTarget", () => ({ completionTargetOf: () => target.value }));

const claude = {
  id: "anthropic",
  kind: "anthropic" as const,
  name: "Anthropic Claude",
  baseUrl: "x",
  model: "m",
  auth: "header" as const,
  authHeader: "x-api-key",
  extraHeaders: [],
};

function settings(over: Partial<typeof EMPTY_AI_SETTINGS> = {}) {
  useAiSettings.setState({
    settings: {
      ...EMPTY_AI_SETTINGS,
      enabled: true,
      providers: [claude],
      routing: { ...EMPTY_AI_SETTINGS.routing, inline: "anthropic" },
      ...over,
    },
    secrets: { anthropic: true },
    loaded: true,
  });
}

beforeEach(() => {
  target.value = {
    connectionId: "c1",
    driver: "postgres",
    database: "",
    defaultSchema: "public",
    connected: true,
  };
  useConnections.setState({
    file: {
      version: 1,
      groups: [],
      connections: [
        conn("c1", "dev", { environment: "development" }),
        conn("c2", "prod", { environment: "production" }),
      ],
    },
  });
  useCompletionState.setState({ failures: 0, pausedUntil: null });
  useCopilot.setState({ phase: "out", login: null, error: null });
  settings();
});

describe("completionEnabled", () => {
  it("is on for a routed provider on a connected console", () => {
    expect(completionEnabled("t1")).toBe(true);
  });

  it("is off when AI is off, completions are routed to Off, or no console is connected", () => {
    settings({ enabled: false });
    expect(completionEnabled("t1")).toBe(false);
    settings({ routing: { ...EMPTY_AI_SETTINGS.routing, inline: null } });
    expect(completionEnabled("t1")).toBe(false);
    settings();
    target.value = { ...target.value!, connected: false };
    expect(completionEnabled("t1")).toBe(false);
    target.value = null;
    expect(completionEnabled("t1")).toBe(false);
  });

  /** (spec: ai-providers › AI disabled on production) */
  it("stops on a Production console when the policy disables AI there", () => {
    target.value = { ...target.value!, connectionId: "c2" };
    expect(completionEnabled("t1")).toBe(true); // schema only: completions stay on
    settings({ privacy: { ...EMPTY_AI_SETTINGS.privacy, production: "disabled" } });
    expect(completionEnabled("t1")).toBe(false);
    target.value = { ...target.value!, connectionId: "c1" };
    expect(completionEnabled("t1")).toBe(true); // other environments are unaffected
  });

  it("is off when the editor SQL isn't shared", () => {
    settings({ privacy: { ...EMPTY_AI_SETTINGS.privacy, sql: false } });
    expect(completionEnabled("t1")).toBe(false);
  });

  it("Copilot needs a signed-in account and the completions switch", () => {
    settings({ routing: { ...EMPTY_AI_SETTINGS.routing, inline: "copilot" } });
    expect(completionEnabled("t1")).toBe(false);
    useCopilot.setState({ phase: "in", login: "ada" });
    expect(completionEnabled("t1")).toBe(true);
    settings({
      routing: { ...EMPTY_AI_SETTINGS.routing, inline: "copilot" },
      copilot: { inline: false, chat: false },
    });
    expect(completionEnabled("t1")).toBe(false);
  });

  it("pauses while the provider keeps failing", () => {
    const s = useCompletionState.getState();
    s.recordFailure();
    s.recordFailure();
    s.recordFailure();
    expect(completionsPaused()).toBe(true);
    expect(completionEnabled("t1")).toBe(false);
  });
});

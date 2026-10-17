import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiSettingsPage } from "./AiSettingsPage";
import type { AiSettings } from "./api";
import { useCopilot } from "./copilotStore";
import { EMPTY_AI_SETTINGS, useAiSettings } from "./settingsStore";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  secretSet: vi.fn(),
  secretClear: vi.fn(),
  models: vi.fn(),
  test: vi.fn(),
}));

vi.mock("./api", () => ({
  aiSettingsGet: () => api.get(),
  aiSettingsSet: (s: AiSettings) => api.set(s),
  aiSecretSet: (...a: unknown[]) => api.secretSet(...a),
  aiSecretClear: (...a: unknown[]) => api.secretClear(...a),
  aiModels: (...a: unknown[]) => api.models(...a),
  aiTestProvider: (...a: unknown[]) => api.test(...a),
}));

const claude = {
  id: "anthropic",
  kind: "anthropic" as const,
  name: "Anthropic Claude",
  baseUrl: "https://api.anthropic.com",
  model: "claude-sonnet-5-5",
  auth: "header" as const,
  authHeader: "x-api-key",
  extraHeaders: [],
};

function state(over: Partial<AiSettings> = {}, secrets: Record<string, boolean> = {}) {
  useAiSettings.setState({
    settings: { ...EMPTY_AI_SETTINGS, ...over },
    secrets,
    loaded: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useCopilot.setState({ phase: "out", login: null, error: null });
  api.set.mockImplementation(async (s: AiSettings) => ({
    settings: s,
    secrets: useAiSettings.getState().secrets,
    notice: null,
  }));
  api.secretSet.mockResolvedValue(undefined);
  api.secretClear.mockResolvedValue(undefined);
  api.models.mockResolvedValue([]);
  state();
});

const row = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });

describe("AI settings page (spec: ai-providers › AI settings page)", () => {
  it("shows every provider as not set up and AI off on a fresh install (spec: ai-providers › Fresh install)", () => {
    render(<AiSettingsPage />);
    expect(screen.getByRole("checkbox", { name: /Enable AI features/ })).not.toBeChecked();
    for (const name of ["Anthropic Claude", "OpenAI", "Custom endpoint", "Local model"]) {
      expect(within(row(name)).getByText("Not set up")).toBeTruthy();
    }
    expect(within(row("GitHub Copilot")).getByText("Not signed in")).toBeTruthy();
    expect(api.test).not.toHaveBeenCalled();
    expect(api.models).not.toHaveBeenCalled();
  });

  it("shows the Claude form with the default model and base URL", () => {
    render(<AiSettingsPage />);
    fireEvent.click(row("Anthropic Claude"));
    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe(
      "https://api.anthropic.com",
    );
    expect((screen.getByLabelText("Chat model") as HTMLSelectElement).value).toBe(
      "claude-sonnet-5-5",
    );
    expect((screen.getByLabelText("API key") as HTMLInputElement).type).toBe("password");
  });

  it("saves a key to the keychain, not into the settings, and switches AI on (spec: ai-providers › API-key providers)", async () => {
    render(<AiSettingsPage />);
    fireEvent.click(row("Anthropic Claude"));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-ant-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.set).toHaveBeenCalled());
    expect(api.secretSet).toHaveBeenCalledWith("anthropic", "sk-ant-123");
    const saved = api.set.mock.calls[0][0] as AiSettings;
    expect(JSON.stringify(saved)).not.toContain("sk-ant-123");
    expect(saved.providers[0].id).toBe("anthropic");
    expect(saved.enabled).toBe(true);
  });

  it("won't save without a key", async () => {
    render(<AiSettingsPage />);
    fireEvent.click(row("OpenAI"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter the API key");
    expect(api.set).not.toHaveBeenCalled();
  });

  it("fills the model list after a successful test (spec: ai-providers › Model list)", async () => {
    api.test.mockResolvedValue({
      ok: true,
      millis: 5,
      message: "Reachable · model responded in 5 ms",
    });
    api.models.mockResolvedValue([
      { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
      { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    ]);
    render(<AiSettingsPage />);
    fireEvent.click(row("Anthropic Claude"));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "k" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Reachable · model responded in 5 ms")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Claude Opus 5.5" })).toBeTruthy(),
    );
    expect(api.test.mock.calls[0][1]).toBe("k");
  });

  it("shows a rejected key and keeps the provider not set up (spec: ai-providers › Invalid key)", async () => {
    api.test.mockRejectedValue({ code: "ai_auth", message: "The API key was rejected (401)" });
    render(<AiSettingsPage />);
    fireEvent.click(row("Anthropic Claude"));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("The API key was rejected (401)")).toBeTruthy();
    expect(within(row("Anthropic Claude")).getByText("Not set up")).toBeTruthy();
  });

  it("adds a custom endpoint and tests it (spec: ai-providers › Company gateway)", async () => {
    api.test.mockResolvedValue({
      ok: true,
      millis: 640,
      message: "Reachable · model responded in 640 ms",
    });
    render(<AiSettingsPage />);
    fireEvent.click(row("Custom endpoint"));
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Team gateway" } });
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "https://llm.internal.example.com/v1" },
    });
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "tok" } });
    fireEvent.change(screen.getByLabelText("Model ID"), { target: { value: "gpt-x" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/Reachable · model responded in 640 ms/)).toBeTruthy();
    const sent = api.test.mock.calls[0][0];
    expect(sent).toMatchObject({
      kind: "custom_openai",
      name: "Team gateway",
      baseUrl: "https://llm.internal.example.com/v1",
      model: "gpt-x",
    });
  });

  it("warns about plain http to another machine and needs confirmation (spec: ai-providers › Plain HTTP)", async () => {
    render(<AiSettingsPage />);
    fireEvent.click(row("Custom endpoint"));
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "gw" } });
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "http://gateway.corp.example.com/v1" },
    });
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "t" } });
    fireEvent.change(screen.getByLabelText("Model ID"), { target: { value: "m" } });
    expect(screen.getByText(/sent unencrypted/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Confirm that the token may be sent unencrypted")).toBeTruthy();
    expect(api.set).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Save it anyway" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.set).toHaveBeenCalled());
  });

  it("doesn't warn for http on this machine", () => {
    render(<AiSettingsPage />);
    fireEvent.click(row("Local model"));
    expect((screen.getByLabelText("Endpoint") as HTMLInputElement).value).toBe(
      "http://localhost:11434",
    );
    expect(screen.queryByText(/sent unencrypted/)).toBeNull();
  });

  it("shows the local server error from Test connection (spec: ai-providers › Server not running)", async () => {
    api.test.mockRejectedValue({
      code: "ai_unreachable",
      message: "Nothing is listening on localhost:11434 — is Ollama running?",
    });
    render(<AiSettingsPage />);
    fireEvent.click(row("Local model"));
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(
      await screen.findByText("Nothing is listening on localhost:11434 — is Ollama running?"),
    ).toBeTruthy();
  });
});

describe("feature routing (spec: ai-providers › Feature routing)", () => {
  it("offers only configured providers, plus Off for completions", () => {
    state({ providers: [claude] }, { anthropic: true });
    render(<AiSettingsPage />);
    const inline = screen.getByLabelText("Inline completions provider") as HTMLSelectElement;
    expect([...inline.options].map((o) => o.text)).toEqual([
      "Off",
      "Anthropic Claude · Sonnet 5.5",
    ]);
    const fix = screen.getByLabelText("Error assistant provider") as HTMLSelectElement;
    expect([...fix.options].map((o) => o.text)[0]).toBe("Same as chat");
  });

  it("offers Copilot for completions only once it is signed in", () => {
    state({ providers: [claude] }, { anthropic: true });
    useCopilot.setState({ phase: "in", login: "ada" });
    render(<AiSettingsPage />);
    const inline = screen.getByLabelText("Inline completions provider") as HTMLSelectElement;
    expect([...inline.options].map((o) => o.text)).toContain("GitHub Copilot");
  });

  it("saves a routing change", async () => {
    state({ providers: [claude] }, { anthropic: true });
    render(<AiSettingsPage />);
    fireEvent.change(screen.getByLabelText("Chat provider"), { target: { value: "anthropic" } });
    await waitFor(() => expect(api.set).toHaveBeenCalled());
    expect((api.set.mock.calls[0][0] as AiSettings).routing.chat).toBe("anthropic");
  });

  it("removing a provider also drops its key (spec: ai-providers › Provider removed)", async () => {
    state(
      { providers: [claude], routing: { ...EMPTY_AI_SETTINGS.routing, chat: "anthropic" } },
      { anthropic: true },
    );
    render(<AiSettingsPage />);
    fireEvent.click(row("Anthropic Claude"));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.secretClear).toHaveBeenCalledWith("anthropic"));
    await waitFor(() => expect(api.set).toHaveBeenCalled());
    expect((api.set.mock.calls[0][0] as AiSettings).providers).toEqual([]);
  });
});

describe("data-sharing policy (spec: ai-providers › Data-sharing policy)", () => {
  it("starts with schema and SQL shared, rows not, and production schema-only", () => {
    render(<AiSettingsPage />);
    expect(screen.getByRole("checkbox", { name: /Schema: table, column/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /The SQL in the editor/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Sample rows from results/ })).not.toBeChecked();
    expect((screen.getByLabelText("On Production connections") as HTMLSelectElement).value).toBe(
      "schema_only",
    );
  });

  it("persists each change", async () => {
    render(<AiSettingsPage />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Sample rows from results/ }));
    await waitFor(() => expect(api.set).toHaveBeenCalledTimes(1));
    expect((api.set.mock.calls[0][0] as AiSettings).privacy.rows).toBe(true);
    fireEvent.change(screen.getByLabelText("On Production connections"), {
      target: { value: "disabled" },
    });
    await waitFor(() => expect(api.set).toHaveBeenCalledTimes(2));
    expect((api.set.mock.calls[1][0] as AiSettings).privacy.production).toBe("disabled");
  });
});

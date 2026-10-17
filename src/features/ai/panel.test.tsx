import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnections } from "../../connections/connectionsStore";
import { setPlatformForTests } from "../../lib/platform";
import { clearCommands } from "../../shell/registry/commands";
import { clearShortcuts } from "../../shell/registry/shortcuts";
import { useNotices } from "../../stores/noticesStore";
import { useSettings } from "../../stores/settingsStore";
import { openConsole } from "../console/commands";
import { useExplorer } from "../explorer/explorerStore";
import { conn } from "../explorer/testing";
import type { AiEvent, ChatInput } from "./api";
import { AiPanel } from "./AiPanel";
import { useChat } from "./chatStore";
import { EMPTY_AI_SETTINGS, useAiSettings } from "./settingsStore";

const api = vi.hoisted(() => ({
  chat: vi.fn(),
  cancel: vi.fn(),
  policy: vi.fn(),
  save: vi.fn(),
  list: vi.fn(),
  load: vi.fn(),
  del: vi.fn(),
}));

vi.mock("./api", () => ({
  aiChat: (...a: unknown[]) => api.chat(...a),
  aiCancel: (...a: unknown[]) => api.cancel(...a),
  aiPolicy: (...a: unknown[]) => api.policy(...a),
  aiChatSave: (...a: unknown[]) => api.save(...a),
  aiChatsList: (...a: unknown[]) => api.list(...a),
  aiChatLoad: (...a: unknown[]) => api.load(...a),
  aiChatsDelete: (...a: unknown[]) => api.del(...a),
}));
vi.mock("../console/commands", () => ({
  openConsole: vi.fn().mockResolvedValue(null),
  activeConsoleTab: () => null,
  sqlToRun: () => null,
}));
vi.mock("../console/completion/snapshots", () => ({
  loadSnapshot: vi.fn().mockResolvedValue({ schemas: [] }),
  peekSnapshot: () => ({
    schemas: [
      {
        name: "public",
        tables: [
          { name: "orders", kind: "table", columns: [] },
          { name: "shipments", kind: "table", columns: [] },
        ],
        functions: [],
      },
    ],
  }),
}));

const dev = conn("c1", "dev-postgres", { environment: "development" });
const prod = conn("c2", "prod-postgres", { environment: "production" });

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

/** A request the test drives by hand: emit events, then finish or fail it. */
interface Live {
  input: ChatInput;
  emit: (e: AiEvent) => void;
  finish: () => void;
  fail: (error: { code: string; message: string }) => void;
}
let live: Live[] = [];

function setup(connectionId = "c1", enabled = true) {
  useConnections.setState({
    file: { version: 1, groups: [], connections: [dev, prod] },
    connected: {},
  });
  useExplorer.setState({ selectedId: connectionId });
  useAiSettings.setState({
    settings: { ...EMPTY_AI_SETTINGS, enabled, providers: enabled ? [claude] : [] },
    secrets: { anthropic: enabled },
    loaded: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(openConsole).mockResolvedValue(null);
  clearShortcuts();
  clearCommands();
  setPlatformForTests("mac");
  live = [];
  useChat.setState({
    chats: {},
    composers: {},
    mode: "ask",
    pick: null,
    view: "chat",
    running: null,
  });
  useNotices.setState({ notices: [] });
  api.policy.mockImplementation(async (id: string) => ({
    allowed: true,
    schema: true,
    sql: true,
    rows: id !== "c2",
    production: id === "c2",
  }));
  api.save.mockResolvedValue(undefined);
  api.cancel.mockResolvedValue(true);
  api.list.mockResolvedValue([]);
  api.chat.mockImplementation(
    (input: ChatInput, onEvent: (e: AiEvent) => void) =>
      new Promise<void>((resolve, reject) => {
        live.push({
          input,
          emit: (e) => act(() => onEvent(e)),
          finish: () => act(() => (onEvent({ kind: "done" }), resolve())),
          fail: (e) => act(() => reject(e)),
        });
      }),
  );
  setup();
});
afterEach(() => {
  useExplorer.setState({ selectedId: null });
});

const composer = () => screen.getByLabelText("Ask the assistant") as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(composer(), { target: { value: text } });
const send = () => fireEvent.keyDown(composer(), { key: "Enter" });

describe("assistant panel (spec: ai-assistant › Assistant side panel)", () => {
  /** (spec: ai-assistant › No provider) */
  it("asks to connect a model when none is configured, with a button to Settings", () => {
    setup("c1", false);
    render(<AiPanel />);
    expect(screen.getByText("Connect a model to start")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Open Settings › AI assistant/ }));
    expect(useSettings.getState().dialogOpen).toBe(true);
    expect(useSettings.getState().section).toBe("AI assistant");
  });

  it("shows the composer with the connection, mode switch, model and Send", async () => {
    render(<AiPanel />);
    expect(await screen.findByLabelText("Ask the assistant")).toBeTruthy();
    expect(composer().placeholder).toBe(
      "Ask about dev-postgres…  @ to mention a table, / for commands",
    );
    const chips = composer().closest("div")!.parentElement!;
    expect(within(chips).getByText("dev-postgres")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Ask" })).toBeChecked();
    expect(screen.getByRole("button", { name: /Model: Anthropic Claude Sonnet 5.5/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("shows the Production notice on a production connection (spec: ai-assistant › Assistant side panel)", async () => {
    setup("c2");
    render(<AiPanel />);
    expect(
      await screen.findByText("Production: AI never runs SQL. Schema only, no row data."),
    ).toBeTruthy();
  });

  it("is off for Production when the policy says so (spec: ai-providers › AI disabled on production)", async () => {
    setup("c2");
    api.policy.mockResolvedValue({
      allowed: false,
      schema: false,
      sql: false,
      rows: false,
      production: true,
    });
    render(<AiPanel />);
    expect(await screen.findByText("AI is off for Production connections")).toBeTruthy();
    expect(screen.queryByLabelText("Ask the assistant")).toBeNull();
  });
});

describe("composer (spec: ai-assistant › Composer)", () => {
  it("sends on Enter and keeps a newline for Shift+Enter", async () => {
    render(<AiPanel />);
    await screen.findByLabelText("Ask the assistant");
    type("why is it slow?");
    fireEvent.keyDown(composer(), { key: "Enter", shiftKey: true });
    expect(live).toHaveLength(0);
    send();
    await waitFor(() => expect(live).toHaveLength(1));
    expect(live[0].input).toMatchObject({
      text: "why is it slow?",
      mode: "ask",
      feature: "chat",
      connectionId: "c1",
      providerId: "anthropic",
      model: "claude-sonnet-5-5",
    });
    expect(composer().value).toBe("");
  });

  /** (spec: ai-assistant › Mention a table) */
  it("mentions a table with @ and sends it as context", async () => {
    render(<AiPanel />);
    await screen.findByLabelText("Ask the assistant");
    type("how many @ord");
    composer().setSelectionRange(13, 13);
    fireEvent.select(composer());
    const list = await screen.findByRole("listbox", { name: "Tables" });
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["orders"]);
    fireEvent.keyDown(composer(), { key: "Enter" });
    expect(composer().value).toBe("how many @orders ");
    expect(screen.getByText("@orders")).toBeTruthy();
    send();
    await waitFor(() => expect(live).toHaveLength(1));
    expect(live[0].input.mentions).toEqual(["orders"]);
  });

  /** (spec: ai-assistant › Slash command) */
  it("expands /optimize into the request the model gets", async () => {
    render(<AiPanel />);
    await screen.findByLabelText("Ask the assistant");
    type("/opt");
    composer().setSelectionRange(4, 4);
    fireEvent.select(composer());
    expect(await screen.findByRole("option", { name: /\/optimize/ })).toBeTruthy();
    fireEvent.keyDown(composer(), { key: "Tab" });
    expect(composer().value).toBe("/optimize ");
    send();
    await waitFor(() => expect(live).toHaveLength(1));
    expect(live[0].input.text).toMatch(/^Optimize this query for speed/);
    expect(live[0].input.feature).toBe("chat");
  });

  it("/fix goes to the error assistant and /generate to natural-language SQL", async () => {
    render(<AiPanel />);
    await screen.findByLabelText("Ask the assistant");
    type("/fix");
    send();
    await waitFor(() => expect(live).toHaveLength(1));
    expect(live[0].input.feature).toBe("fix");
    live[0].finish();
    await waitFor(() => expect(useChat.getState().running).toBeNull());
    type("/generate revenue by month");
    send();
    await waitFor(() => expect(live).toHaveLength(2));
    expect(live[1].input.feature).toBe("nl_sql");
    expect(live[1].input.text).toBe("Write a query for this: revenue by month");
  });

  it("switches between Ask and Edit", async () => {
    render(<AiPanel />);
    await screen.findByLabelText("Ask the assistant");
    fireEvent.click(screen.getByRole("radio", { name: "Edit" }));
    expect(screen.getByRole("radio", { name: "Edit" })).toBeChecked();
    type("rewrite");
    send();
    await waitFor(() => expect(live).toHaveLength(1));
    expect(live[0].input.mode).toBe("edit");
  });

  /** (spec: ai-providers › Production schema-only) */
  it("refuses to attach rows on a Production connection", async () => {
    setup("c2");
    render(<AiPanel />);
    await screen.findByLabelText("Ask the assistant");
    fireEvent.click(screen.getByRole("button", { name: "+ context" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Result rows/ }));
    await waitFor(() =>
      expect(useNotices.getState().notices.map((n) => n.message)).toContain(
        "Row data isn't shared for Production connections",
      ),
    );
  });
});

describe("streaming answers (spec: ai-assistant › Streaming answers)", () => {
  it("streams text with a model header naming what was read, then offers follow-ups", async () => {
    render(<AiPanel />);
    await screen.findByLabelText("Ask the assistant");
    type("fix it");
    send();
    await waitFor(() => expect(live).toHaveLength(1));
    expect(screen.getByRole("status")).toHaveTextContent("Thinking…");
    live[0].emit({ kind: "read", tables: ["orders", "shipments"] });
    live[0].emit({ kind: "text", text: "`carrier` lives on " });
    live[0].emit({ kind: "text", text: "**shipments**." });
    const msg = screen.getByTestId("assistant-message");
    expect(msg).toHaveTextContent("Claude Sonnet 5.5 · read schema of orders, shipments");
    expect(msg).toHaveTextContent("carrier lives on shipments.");
    expect(msg.dataset.status).toBe("streaming");
    live[0].emit({ kind: "suggestions", items: ["Draft the index"] });
    expect(screen.queryByRole("button", { name: "Draft the index" })).toBeNull(); // not until done
    live[0].finish();
    const chip = await screen.findByRole("button", { name: "Draft the index" });
    fireEvent.click(chip);
    await waitFor(() => expect(live).toHaveLength(2));
    expect(live[1].input.text).toBe("Draft the index");
  });

  it("shows the context that was sent (spec: ai-providers › What was sent)", async () => {
    render(<AiPanel />);
    await screen.findByLabelText("Ask the assistant");
    type("hi");
    send();
    await waitFor(() => expect(live).toHaveLength(1));
    live[0].emit({
      kind: "context",
      items: [
        { kind: "dialect", label: "dialect", content: "PostgreSQL, server version 16.2" },
        { kind: "schema", label: "schema of orders", content: "orders (table): id integer" },
      ],
    });
    live[0].emit({ kind: "text", text: "ok" });
    live[0].finish();
    fireEvent.click(await screen.findByRole("button", { name: "Context sent (2)" }));
    const list = screen.getByRole("list", { name: "Context sent" });
    expect(list).toHaveTextContent("PostgreSQL, server version 16.2");
    expect(list).toHaveTextContent("orders (table): id integer");
  });

  /** (spec: ai-assistant › Stop) */
  it("Stop keeps the partial reply, marked Stopped", async () => {
    render(<AiPanel />);
    await screen.findByLabelText("Ask the assistant");
    type("long one");
    send();
    await waitFor(() => expect(live).toHaveLength(1));
    live[0].emit({ kind: "text", text: "Partial answer" });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(api.cancel).toHaveBeenCalledWith(live[0].input.requestId);
    live[0].fail({ code: "cancelled", message: "Stopped" });
    await waitFor(() => expect(screen.getByText("Stopped")).toBeTruthy());
    expect(screen.getByTestId("assistant-message")).toHaveTextContent("Partial answer");
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("Esc in the composer stops a streaming reply", async () => {
    render(<AiPanel />);
    await screen.findByLabelText("Ask the assistant");
    type("x");
    send();
    await waitFor(() => expect(live).toHaveLength(1));
    fireEvent.keyDown(composer(), { key: "Escape" });
    expect(api.cancel).toHaveBeenCalled();
  });

  /** (spec: ai-assistant › Provider error) */
  it("shows a provider error with Retry and keeps what the user was typing", async () => {
    render(<AiPanel />);
    await screen.findByLabelText("Ask the assistant");
    type("first question");
    send();
    await waitFor(() => expect(live).toHaveLength(1));
    live[0].fail({
      code: "ai_rate_limited",
      message: "The provider is rate limiting requests (429)",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("rate limiting");
    type("a follow-up I was typing");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(live).toHaveLength(2));
    expect(live[1].input.text).toBe("first question");
    expect(composer().value).toBe("a follow-up I was typing");
    expect(screen.getAllByText("first question")).toHaveLength(1); // not duplicated
  });

  it("copies and inserts code blocks", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<AiPanel />);
    await screen.findByLabelText("Ask the assistant");
    type("sql please");
    send();
    await waitFor(() => expect(live).toHaveLength(1));
    live[0].emit({ kind: "text", text: "Try:\n\n```sql\nSELECT 1\n```" });
    live[0].finish();
    fireEvent.click(await screen.findByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("SELECT 1");
    expect(screen.getByRole("button", { name: "Insert at cursor" })).toBeTruthy();
  });
});

describe("chat history (spec: ai-assistant › Chat history)", () => {
  it("lists past chats and reopens one", async () => {
    api.list.mockResolvedValue([
      {
        id: "ch1",
        connectionId: "c1",
        title: "Why is orders slow?",
        createdAt: 1,
        updatedAt: 1_700_000_000_000,
      },
    ]);
    api.load.mockResolvedValue([
      {
        id: "m1",
        seq: 0,
        role: "user",
        body: JSON.stringify({
          id: "m1",
          role: "user",
          text: "Why is orders slow?",
          at: 1,
          mode: "ask",
        }),
      },
      {
        id: "m2",
        seq: 1,
        role: "assistant",
        body: JSON.stringify({
          id: "m2",
          role: "assistant",
          text: "No index.",
          at: 2,
          mode: "ask",
          status: "streaming",
          model: "Claude Sonnet 5.5",
        }),
      },
    ]);
    render(<AiPanel />);
    await screen.findByLabelText("Ask the assistant");
    act(() => useChat.getState().setView("history"));
    fireEvent.click(await screen.findByRole("button", { name: /^Why is orders slow\?/ }));
    await waitFor(() => expect(useChat.getState().view).toBe("chat"));
    expect(await screen.findByText("No index.")).toBeTruthy();
    // A reply that was cut off when the app closed reads as stopped.
    expect(screen.getByText("Stopped")).toBeTruthy();
  });

  it("deletes one chat or all of them", async () => {
    api.list.mockResolvedValue([
      { id: "ch1", connectionId: "c1", title: "A", createdAt: 1, updatedAt: 1 },
    ]);
    api.del.mockResolvedValue(1);
    render(<AiPanel />);
    await screen.findByLabelText("Ask the assistant");
    act(() => useChat.getState().setView("history"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete chat: A" }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith({ chatId: "ch1" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete all chats" }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith({ connectionId: "c1" }));
  });

  it("saves each message locally as the conversation goes", async () => {
    render(<AiPanel />);
    await screen.findByLabelText("Ask the assistant");
    type("remember me");
    send();
    await waitFor(() => expect(live).toHaveLength(1));
    await waitFor(() => expect(api.save).toHaveBeenCalled());
    const [chat, message] = api.save.mock.calls[0];
    expect(chat.title).toBe("remember me");
    expect(message.role).toBe("user");
    live[0].finish();
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(2));
    expect(api.save.mock.calls[1][1].role).toBe("assistant");
  });
});

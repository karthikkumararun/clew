import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "../../components/icons";
import type { Environment } from "../../components/Badge";
import { useConnections } from "../../connections/connectionsStore";
import { resetUiState } from "../../lib/uiState";
import { setPlatformForTests } from "../../lib/platform";
import { clearCommands, runCommand } from "../../shell/registry/commands";
import { clearShortcuts, dispatchShortcut } from "../../shell/registry/shortcuts";
import { clearTabKinds, registerTabKind } from "../../shell/registry/tabKinds";
import { persistSession } from "../../shell/session";
import { useWorkspace } from "../../stores/workspaceStore";
import { registerWorkspaces } from "./index";
import { LAST_ID } from "./model";
import { WorkspaceSwitcher, switcherItems } from "./WorkspaceSwitcher";
import { saveAs, startWorkspaces, useWorkspaces, workspaceRows } from "./store";

const mocks = vi.hoisted(() => ({ ask: vi.fn(), openConsole: vi.fn(async (_a?: unknown) => "t") }));
vi.mock("../console/prompts", () => ({ askChoice: (p: unknown) => mocks.ask(p) }));
vi.mock("../console/commands", () => ({ openConsole: (a: unknown) => mocks.openConsole(a) }));

interface Doc {
  connectionId: string;
  text: string;
}
const envOf: Record<string, Environment> = { stg1: "staging", prod1: "production" };

const open = (conn: string, text: string) =>
  useWorkspace.getState().openTab<Doc>({
    kind: "console",
    key: `${conn}:${text}`,
    state: { connectionId: conn, text },
  });
const texts = () => useWorkspace.getState().tabs.map((t) => (t.state as Doc).text);

let off: () => void = () => {};
let stop: () => void = () => {};
beforeEach(() => {
  off();
  stop();
  resetUiState();
  clearShortcuts();
  clearCommands();
  clearTabKinds();
  setPlatformForTests("mac");
  registerTabKind<Doc>({
    kind: "console",
    icon: Terminal,
    title: () => "console",
    env: (s) => envOf[s.connectionId],
    render: () => null,
  });
  mocks.ask.mockReset();
  useWorkspace.setState({ tabs: [], activeTabId: null, closeRequest: null });
  useConnections.setState({
    file: {
      connections: [
        { id: "stg1", name: "staging-db" },
        { id: "prod1", name: "prod-db" },
      ],
      groups: [],
    } as never,
  });
  useWorkspaces.setState({ menuOpen: false, manageOpen: false, saveAsOpen: false });
  stop = startWorkspaces();
  off = registerWorkspaces();
});

describe("workspace switcher (spec: workspaces › Environment grouping; workspaces › Switching workspaces)", () => {
  it("lists workspaces under their environment, with the open one marked", () => {
    open("stg1", "select 1");
    open("prod1", "select 2");
    persistSession();
    const items = switcherItems(workspaceRows(), LAST_ID);
    const labels = items.map((i) => (typeof i.label === "string" ? i.label : i.id));
    expect(labels.slice(-2)).toEqual(["Save workspace as…", "Manage workspaces…"]);
    const ids = items.map((i) => i.id);
    expect(ids.indexOf("h:staging")).toBeLessThan(ids.indexOf("h:production"));
    expect(ids.indexOf("h:production")).toBeLessThan(ids.indexOf("h:mixed"));
    expect(ids).toContain("ws:last");
  });

  it("opens from the toolbar button, and by shortcut, as a menu of workspaces", async () => {
    render(<WorkspaceSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: /Workspace/ }));
    const menu = await screen.findByRole("menu", { name: "Workspaces" });
    expect(within(menu).getByText("Last session")).toBeTruthy();
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(
      dispatchShortcut(
        new KeyboardEvent("keydown", { key: "w", code: "KeyW", metaKey: true, altKey: true }),
      ),
    ).toBe(true);
    await screen.findByRole("menu", { name: "Workspaces" });
  });

  it("switches when a workspace is chosen", async () => {
    open("stg1", "in staging");
    saveAs("Staging work");
    await act(async () => void (await runCommand("workspace.switch")));
    render(<WorkspaceSwitcher />);
    const menu = await screen.findByRole("menu", { name: "Workspaces" });
    fireEvent.click(within(menu).getByText("Last session"));
    await waitFor(() => expect(useWorkspaces.getState().activeId).toBe(LAST_ID));
    expect(texts()).toEqual(["in staging"]); // the last session had them before "Save as"
  });

  it("names a workspace in the Save as dialog and refuses a duplicate name", async () => {
    open("stg1", "x");
    render(<WorkspaceSwitcher />);
    await act(async () => void (await runCommand("workspace.saveAs")));
    const input = await screen.findByLabelText("Workspace name");
    fireEvent.change(input, { target: { value: "Release checklist" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByLabelText("Workspace name")).toBeNull());
    expect(workspaceRows().some((r) => r.meta.name === "Release checklist")).toBe(true);

    await act(async () => void (await runCommand("workspace.saveAs")));
    fireEvent.change(await screen.findByLabelText("Workspace name"), {
      target: { value: "release checklist" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already exists/);
  });

  it("manages: rename, duplicate and delete the open workspace after confirming", async () => {
    open("stg1", "keep");
    saveAs("Temp");
    render(<WorkspaceSwitcher />);
    await act(async () => void (await runCommand("workspace.manage")));
    const dialog = await screen.findByRole("dialog", { name: "Manage workspaces" });
    const row = (name = "Temp") =>
      within(dialog).getByText(name).closest('[role="listitem"]') as HTMLElement;

    fireEvent.click(within(row()).getByRole("button", { name: "Rename" }));
    fireEvent.change(await screen.findByLabelText("Workspace name"), {
      target: { value: "Scratch" },
    });
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Rename workspace" })).getByRole("button", {
        name: "Rename",
      }),
    );
    await waitFor(() => expect(within(dialog).getByText("Scratch")).toBeTruthy());
    fireEvent.click(within(row("Scratch")).getByRole("button", { name: "Duplicate" }));
    expect(within(dialog).getByText("Scratch copy")).toBeTruthy();

    mocks.ask.mockResolvedValueOnce("delete");
    fireEvent.click(within(row("Scratch")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(within(dialog).queryByText("Scratch")).toBeNull());
    expect(texts()).toEqual(["keep"]);
    expect(useWorkspaces.getState().activeId).toBe(LAST_ID);
    // the built-in last session has no rename or delete
    const last = within(dialog)
      .getByText(/Last session/)
      .closest('[role="listitem"]') as HTMLElement;
    expect(within(last).queryByRole("button", { name: "Delete" })).toBeNull();
  });
});

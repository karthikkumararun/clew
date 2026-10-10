import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dialog } from "./Dialog";
import { IconButton } from "./Button";
import { Menu } from "./Menu";
import { SplitPane } from "./SplitPane";
import { Plus } from "./icons";
import { resetUiState } from "../lib/uiState";

beforeEach(() => resetUiState());

describe("Dialog", () => {
  it("traps focus: Tab wraps last -> first and Shift+Tab first -> last", async () => {
    const user = userEvent.setup();
    render(
      <Dialog title="Test" onClose={() => {}}>
        <button>one</button>
        <button>two</button>
      </Dialog>,
    );
    const close = screen.getByRole("button", { name: "Close" });
    const two = screen.getByRole("button", { name: "two" });
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(two).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Dialog title="Test" onClose={onClose}>
        <button>one</button>
      </Dialog>,
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("restores focus to the opener on unmount", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(
      <Dialog title="Test" onClose={() => {}}>
        <button>one</button>
      </Dialog>,
    );
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});

describe("IconButton", () => {
  it("exposes its aria-label as the accessible name", () => {
    render(
      <IconButton aria-label="New connection">
        <Plus />
      </IconButton>,
    );
    expect(screen.getByRole("button", { name: "New connection" })).toBeInTheDocument();
  });
});

describe("Menu", () => {
  it("navigates with arrows and selects with Enter", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <Menu
        aria-label="m"
        onClose={() => {}}
        onSelect={onSelect}
        items={[
          { id: "a", label: "A" },
          { id: "b", label: "B", disabled: true },
          { id: "c", label: "C" },
        ]}
      />,
    );
    expect(screen.getByRole("menuitem", { name: "A" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "C" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("c");
  });
});

describe("SplitPane", () => {
  const setup = (edge: "left" | "right" = "right") =>
    render(
      <SplitPane
        edge={edge}
        defaultSize={272}
        min={240}
        max={420}
        label="sidebar"
        persistKey="t.size"
      >
        <div>content</div>
      </SplitPane>,
    );
  const handle = () => screen.getByRole("separator");

  it("clamps to min and max with the keyboard", () => {
    setup();
    for (let i = 0; i < 50; i++) fireEvent.keyDown(handle(), { key: "ArrowRight" });
    expect(handle()).toHaveAttribute("aria-valuenow", "420");
    for (let i = 0; i < 50; i++) fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    expect(handle()).toHaveAttribute("aria-valuenow", "240");
  });

  it("clamps while dragging and persists the final size", () => {
    setup();
    fireEvent.pointerDown(handle(), { clientX: 272, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 2000, pointerId: 1 });
    fireEvent.pointerUp(handle(), { clientX: 2000, pointerId: 1 });
    expect(handle()).toHaveAttribute("aria-valuenow", "420");
    expect(localStorage.getItem("clew:t.size")).toBe("420");
  });

  it("restores the persisted size and clamps it into range", () => {
    localStorage.setItem("clew:t.size", "9999");
    setup();
    expect(handle()).toHaveAttribute("aria-valuenow", "420");
  });

  it("grows against the pointer for a left-edge handle", () => {
    setup("left");
    fireEvent.pointerDown(handle(), { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 450, pointerId: 1 });
    fireEvent.pointerUp(handle(), { clientX: 450, pointerId: 1 });
    expect(handle()).toHaveAttribute("aria-valuenow", "322");
  });
});

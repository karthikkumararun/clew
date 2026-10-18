import type { MenuItem } from "../../components/Menu";
import type { Connection, Group } from "../../connections/api";
import { ENVIRONMENTS } from "../../connections/draft";
import { graphTargetOf } from "../graph/explorerTarget";
import { isTableLike } from "./names";
import { isMac } from "../../lib/platform";
import type { NodeEntry } from "./tree";

const revealLabel = () => (isMac() ? "Reveal in Finder" : "Reveal in Explorer");

/** Menu entries of a connection row. Ids starting with `env:` / `move:` are handled inline. */
export function connectionMenu(c: Connection, groups: Group[], connected: boolean): MenuItem[] {
  return [
    connected
      ? { id: "connection.disconnect", label: "Disconnect" }
      : { id: "connection.open", label: "Connect" },
    { id: "console.new", label: "New console" },
    { id: "workspace.open", label: "Open workspace" },
    { id: "connection.edit", label: "Edit…" },
    { id: "connection.duplicate", label: "Duplicate" },
    { id: "connection.rename", label: "Rename…" },
    ...ENVIRONMENTS.filter((e) => e.id !== c.environment).map((e) => ({
      id: `env:${e.id}`,
      label: `Change environment: ${e.label}`,
    })),
    ...(c.groupId ? [{ id: "move:", label: "Move to Ungrouped" }] : []),
    ...groups
      .filter((g) => g.id !== c.groupId)
      .map((g) => ({ id: `move:${g.id}`, label: `Move to ${g.name}` })),
    { id: "move:__new__", label: "Move to new group…" },
    { id: "connection.delete", label: "Delete…" },
    { id: "explorer.refresh", label: "Refresh", disabled: !connected },
  ];
}

/** Menu entries of an introspection node, by kind. */
export function nodeMenu(e: NodeEntry, driver?: string): MenuItem[] {
  if (e.kind === "scripts") {
    return [
      { id: "explorer.newScript", label: "New script" },
      { id: "explorer.revealScript", label: revealLabel() },
      { id: "explorer.refresh", label: "Refresh" },
    ];
  }
  if (e.kind === "script") {
    return [
      { id: "explorer.openScript", label: "Open" },
      { id: "explorer.revealScript", label: revealLabel() },
      { id: "explorer.copyName", label: "Copy name" },
    ];
  }
  if (driver === "mongodb" && isTableLike(e.kind)) {
    return [
      { id: "explorer.openData", label: "Open collection" },
      { id: "explorer.openInConsole", label: "Open in shell console" },
      { id: "explorer.copyName", label: "Copy name" },
      { id: "explorer.refresh", label: "Refresh" },
    ];
  }
  if (driver === "neo4j") {
    const g = graphTargetOf(e.path, e.kind);
    if (g) {
      return [
        {
          id: "explorer.openData",
          label:
            g.kind === "database"
              ? "Open Cypher console"
              : g.kind === "label"
                ? "Show nodes"
                : "Show relationships",
        },
        { id: "explorer.copyName", label: "Copy name" },
        { id: "explorer.refresh", label: "Refresh" },
      ];
    }
  }
  if (driver === "redis" && e.kind === "database") {
    return [
      { id: "explorer.openData", label: "Browse keys" },
      { id: "explorer.newConsoleHere", label: "New console here" },
      { id: "explorer.refresh", label: "Refresh" },
    ];
  }
  if (isTableLike(e.kind)) {
    return [
      { id: "explorer.openData", label: "Open data" },
      { id: "explorer.openInConsole", label: "Open in console" },
      { id: "explorer.copyName", label: "Copy name" },
      { id: "explorer.copyQualifiedName", label: "Copy qualified name" },
      { id: "explorer.generateDdl", label: "Generate DDL" },
      { id: "explorer.countRows", label: "Count rows" },
      { id: "explorer.refresh", label: "Refresh" },
    ];
  }
  switch (e.kind) {
    case "database":
    case "schema":
      return [
        { id: "explorer.newConsoleHere", label: "New console here" },
        { id: "explorer.refresh", label: "Refresh" },
        { id: "explorer.copyName", label: "Copy name" },
      ];
    case "column":
      return [
        { id: "explorer.copyName", label: "Copy name" },
        { id: "explorer.filterByColumn", label: "Filter table by this column" },
      ];
    case "group":
      return [{ id: "explorer.refresh", label: "Refresh" }];
    default:
      return [
        { id: "explorer.copyName", label: "Copy name" },
        { id: "explorer.refresh", label: "Refresh" },
      ];
  }
}

import { vi } from "vitest";
import type { GuardReport } from "./ipc";

/** A guard that allows everything, for tests of screens that merely run statements. */
export const allow = (sql = ""): GuardReport => ({
  decision: "allow",
  connection: "",
  environment: "",
  statements: [{ text: sql, class: "read" }],
});

export const safetyCheck = vi.fn(async (_s: string, sql: string) => allow(sql));
export const safetyCheckChanges = vi.fn(async () => allow());
export const sessionReadOnly = vi.fn(async () => false);
export const setSessionReadOnly = vi.fn(async () => {});

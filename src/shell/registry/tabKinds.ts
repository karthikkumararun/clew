import type { ComponentType, ReactNode } from "react";
import type { Environment } from "../../components/Badge";

export interface Tab<S = unknown> {
  id: string;
  kind: string;
  /** Deduplication key, e.g. `table:<connId>:<schema>.<table>`. */
  key: string;
  state: S;
}

export interface TabStatus {
  connection?: {
    state: "connected" | "disconnected";
    name: string;
    serverVersion?: string;
    /** e.g. "via SSH bastion" */
    transport?: string;
    /** The connection's environment; production tints the segment. */
    environment?: string;
  };
  /** Context items for the right side of the status bar (cursor position, encoding, dialect). */
  right?: string[];
}

export interface TabKind<S = unknown> {
  kind: string;
  icon: ComponentType<{ size?: number }>;
  title(state: S): string;
  subtitle?(state: S): string | undefined;
  /** Environment of the bound connection; drives the 2px top stripe. */
  env?(state: S): Environment | undefined;
  render(props: { tab: Tab<S> }): ReactNode;
  isDirty?(state: S): boolean;
  /** Persist the editor's content. Resolve false (or throw) to abort closing. */
  save?(tab: Tab<S>): Promise<boolean>;
  /** Ask before closing for reasons other than unsaved text (e.g. an open transaction). */
  confirmClose?(tab: Tab<S>): Promise<boolean>;
  /** Release what the tab holds (a database session, a file watch) once it is closed. */
  onClose?(tab: Tab<S>): void;
  status?(state: S): TabStatus | undefined;
  serialize?(state: S): unknown;
  deserialize?(raw: unknown): S;
}

const kinds = new Map<string, TabKind<never>>();

export function registerTabKind<S>(def: TabKind<S>): () => void {
  kinds.set(def.kind, def as unknown as TabKind<never>);
  return () => {
    if (kinds.get(def.kind) === (def as unknown as TabKind<never>)) kinds.delete(def.kind);
  };
}

export function getTabKind(kind: string): TabKind | undefined {
  return kinds.get(kind) as unknown as TabKind | undefined;
}

export function clearTabKinds() {
  kinds.clear();
}

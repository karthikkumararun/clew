import type { Server } from "node:http";
export const SCRIPTS: Record<string, { text: string; tool?: { name: string; input: unknown } }>;
export function createMockServer(): { server: Server; log: unknown[] };

import { invoke } from "../../lib/ipc";

export const copilotComplete = (input: {
  requestId: string;
  connectionId: string;
  documentId: string;
  prefix: string;
  suffix: string;
}) => invoke<string[]>("copilot_complete", { input });

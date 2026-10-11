import { askChoice } from "../console/prompts";

/** Ask whether this session may write. Resolves true when the user agrees. */
export async function confirmSwitchToReadWrite(connectionName: string): Promise<boolean> {
  const answer = await askChoice({
    title: "Switch to read-write?",
    body: (
      <p>
        This session on <strong>{connectionName}</strong> will be able to change data until it is
        closed. Other tabs stay read-only.
      </p>
    ),
    choices: [
      { id: "cancel", label: "Cancel" },
      { id: "write", label: "Switch to read-write", variant: "primary" },
    ],
  });
  return answer === "write";
}

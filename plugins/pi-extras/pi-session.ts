import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type TextTask = "title" | "commit";

export function piBridgeSessionDir(home = homedir()): string {
  return join(home, ".bb", "pi-extras-sessions");
}

/** Create a recognizable trace path without putting prompt content in its name. */
export async function createTextSessionPath(task: TextTask, directory = piBridgeSessionDir()): Promise<string> {
  await mkdir(directory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(directory, `pi-extras-${task}-${timestamp}-${randomUUID()}.jsonl`);
}

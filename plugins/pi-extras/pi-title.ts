// BB renders instructions followed by a Task section. The user text can itself
// contain "Task:", so only split at the first section marker.
const TASK_MARKER = "\nTask:\n";

export function splitTitlePrompt(prompt: string): { instructions: string; task: string } | null {
  const index = prompt.indexOf(TASK_MARKER);
  if (index < 0) return null;
  const task = prompt.slice(index + TASK_MARKER.length);
  return task.trim() ? { instructions: prompt.slice(0, index).trim(), task } : null;
}

export function titleServiceArgs({ prompt, model }: { prompt: string; model: string | null }): string[] {
  const parts = splitTitlePrompt(prompt);
  const args = [
    "-p", "--mode", "json", "--no-tools", "--no-session", "--no-approve",
    "--no-context-files", "--no-skills", "--no-prompt-templates", "--thinking", "off",
  ];
  if (model) args.push("--model", model);
  if (parts) args.push("--system-prompt", parts.instructions);
  args.push(parts ? `Task:\n${parts.task}` : prompt);
  return args;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Pick the last usable assistant answer from Pi's JSONL agent_end events. */
export function parseTitleEnvelope(stdout: string): { text: string; model: string | null } | null {
  let answer: { text: string; model: string | null } | null = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!record(event) || event.type !== "agent_end" || !Array.isArray(event.messages)) continue;
    for (const message of event.messages) {
      if (!record(message) || message.role !== "assistant" ||
        (message.stopReason !== undefined && message.stopReason !== "stop") || !Array.isArray(message.content)) continue;
      const texts = message.content.filter(record)
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => (block.text as string).trim()).filter(Boolean);
      const text = texts.at(-1);
      if (!text) continue;
      const provider = typeof message.provider === "string" ? message.provider : null;
      const model = typeof message.model === "string" ? message.model : null;
      answer = { text, model: provider && model ? `${provider}/${model}` : model };
    }
  }
  return answer;
}

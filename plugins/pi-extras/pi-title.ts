// BB renders instructions followed by a Task section. The user text can itself
// contain "Task:", so only split at the first section marker.
const TASK_MARKER = "\nTask:\n";

/**
 * BB's `complete()` is one function for both thread titles and commit messages
 * and passes no task argument, so the prompt is the only signal. The commit
 * template is distinctive: it is the only one that names a commit message and
 * carries the diff sections. Anything unrecognised is treated as a title,
 * which is the older and more common path.
 */
export function isCommitPrompt(prompt: string): boolean {
  return (
    prompt.includes("commit message") &&
    prompt.includes("Shortstat:") &&
    prompt.includes("Files (name-status):")
  );
}

export function splitTextPrompt(prompt: string): { instructions: string; task: string } | null {
  const index = prompt.indexOf(TASK_MARKER);
  if (index < 0) return null;
  const task = prompt.slice(index + TASK_MARKER.length);
  return task.trim() ? { instructions: prompt.slice(0, index).trim(), task } : null;
}

export function textServiceArgs({ prompt, model }: { prompt: string; model: string | null }): string[] {
  const parts = splitTextPrompt(prompt);
  // Text mode, not JSON: BB renders a commit prompt with the whole diff in it,
  // and JSON mode echoes the entire conversation back on stdout, which is about
  // three and a half times the prompt. A 21 KB diff produced 77 KB of JSON and
  // 52 bytes of text. BB cleans the reply for both tasks, so the raw line is
  // what we want.
  const args = [
    "-p", "--mode", "text", "--no-tools", "--no-session", "--no-approve",
    "--no-context-files", "--no-skills", "--no-prompt-templates", "--thinking", "off",
  ];
  if (model) args.push("--model", model);
  if (parts) args.push("--system-prompt", parts.instructions);
  args.push(parts ? `Task:\n${parts.task}` : prompt);
  return args;
}

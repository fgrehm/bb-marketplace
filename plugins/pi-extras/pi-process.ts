import { spawn } from "node:child_process";

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: string | null;
}

export interface ProcessOptions {
  input?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  maxStdoutBytes: number;
}

export type ProcessRunner = (command: string, args: string[], options: ProcessOptions) => Promise<ProcessResult>;

/** Both Pi RPC and print mode require stdin to reach EOF. */
export const runProcess: ProcessRunner = (command, args, options) => new Promise((resolve) => {
  const { input, env = process.env, signal, timeoutMs, maxStdoutBytes } = options;
  if (signal?.aborted) {
    resolve({ code: null, stdout: "", stderr: "", timedOut: false, error: "Aborted" });
    return;
  }
  const child = spawn(command, args, { env, stdio: "pipe" });
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let settled = false;
  const finish = (code: number | null, error: string | null = null, timedOut = false) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (error !== null || timedOut) child.kill();
    resolve({ code, stdout, stderr, timedOut, error });
  };
  const onAbort = () => finish(null, "Aborted");
  const timer = setTimeout(() => finish(null, null, true), timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxStdoutBytes) finish(null, "Pi output was too large to read.");
    else stdout += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
  child.stdin.on("error", () => { /* Pi can exit before reading input. */ });
  child.on("error", (error) => finish(null, error.message));
  child.on("close", (code) => finish(code));
  signal?.addEventListener("abort", onAbort, { once: true });
  child.stdin.end(input);
});

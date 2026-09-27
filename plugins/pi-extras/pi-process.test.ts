import assert from "node:assert/strict";
import test from "node:test";
import { runProcess } from "./pi-process.ts";

test("closes stdin after passing input", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdin.on('end', () => console.log('eof')); process.stdin.resume()"], {
    timeoutMs: 2_000,
    maxStdoutBytes: 100,
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), "eof");
  assert.equal(result.timedOut, false);
});

test("passes RPC input and ends stdin", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
    input: "request\n",
    timeoutMs: 2_000,
    maxStdoutBytes: 100,
  });
  assert.equal(result.stdout, "request\n");
});

test("bounds output and kills a stalled process", async () => {
  const overflow = await runProcess(process.execPath, ["-e", "process.stdout.write('overlong')"], {
    timeoutMs: 2_000,
    maxStdoutBytes: 3,
  });
  assert.match(overflow.error ?? "", /large/i);

  const timeout = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
    timeoutMs: 100,
    maxStdoutBytes: 100,
  });
  assert.equal(timeout.timedOut, true);
});

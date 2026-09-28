import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTextSessionPath, piBridgeSessionDir } from "./pi-session.ts";

test("creates recognizable, unique helper traces in the dedicated BB directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-extras-session-test-"));
  try {
    const dir = join(root, "sessions");
    const first = await createTextSessionPath("commit", dir);
    const second = await createTextSessionPath("commit", dir);
    assert.notEqual(first, second);
    assert.match(first, /pi-extras-commit-.*\.jsonl$/);
    assert.equal(first.startsWith(`${dir}/`), true);
    assert.equal(piBridgeSessionDir(root), join(root, ".bb", "pi-extras-sessions"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

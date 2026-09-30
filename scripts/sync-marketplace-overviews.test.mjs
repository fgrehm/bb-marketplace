import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { syncMarketplaceOverviews } from "./sync-marketplace-overviews.mjs";

const entry = (id, overview = "Old copy") => ({
  id,
  displayName: id,
  description: "Keep this description",
  overview,
  icon: "BookOpen",
  screenshots: ["https://example.com/screenshot.png"],
  tags: ["notes"],
  author: { name: "Example" },
  source: {
    git: {
      url: "https://example.com/repo.git",
      subdir: `plugins/${id}`,
      range: "^0.1.0",
      tagPrefix: `${id}/`,
    },
  },
});

async function fixture(t, entries = [entry("example")]) {
  const rootDir = await mkdtemp(join(tmpdir(), "marketplace-overviews-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const catalog = {
    $schema: "https://getbb.app/schemas/marketplace-v2.schema.json",
    schemaVersion: 2,
    name: "example",
    displayName: "Example catalog",
    categories: [{ id: "notes", displayName: "Notes", description: "Notes" }],
    plugins: entries,
  };
  const catalogPath = join(rootDir, "marketplace.json");
  await writeFile(catalogPath, JSON.stringify(catalog));
  const source = async (id, text) => {
    const directory = join(rootDir, "plugins", id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "PLUGIN_OVERVIEW.md"), text);
  };
  return { rootDir, catalog, catalogPath, source };
}

test("updates only overview fields for catalogued plugins and preserves Markdown formatting", async (t) => {
  const f = await fixture(t, [entry("one"), entry("two")]);
  const first = "## Overview\n\nA paragraph.\n\n- An item\n- Another item";
  await f.source("one", `${first}\n`);
  await f.source("two", "    An indented code block\n");
  await f.source("uncatalogued", "");
  assert.deepEqual(await syncMarketplaceOverviews({ rootDir: f.rootDir }), [
    "one",
    "two",
  ]);
  const output = JSON.parse(await readFile(f.catalogPath, "utf8"));
  const expected = structuredClone(f.catalog);
  expected.plugins[0].overview = first;
  expected.plugins[1].overview = "    An indented code block";
  assert.deepEqual(output, expected);
});

test("normalizes BOM, CRLF, and surrounding newlines, retaining Unicode", async (t) => {
  const f = await fixture(t);
  await f.source("example", "\uFEFF\r\n## Notes\r\n\r\nUseful 🔎\r\n\r\n");
  await syncMarketplaceOverviews({ rootDir: f.rootDir });
  assert.equal(
    JSON.parse(await readFile(f.catalogPath, "utf8")).plugins[0].overview,
    "## Notes\n\nUseful 🔎",
  );
});

test("check mode reports stale copy without writing, then passes after sync", async (t) => {
  const f = await fixture(t);
  await f.source("example", "New copy\n");
  const before = await readFile(f.catalogPath, "utf8");
  await assert.rejects(
    syncMarketplaceOverviews({ rootDir: f.rootDir, check: true }),
    /out of sync.*example.*node scripts\/sync-marketplace-overviews\.mjs/s,
  );
  assert.equal(await readFile(f.catalogPath, "utf8"), before);
  await syncMarketplaceOverviews({ rootDir: f.rootDir });
  assert.deepEqual(
    await syncMarketplaceOverviews({ rootDir: f.rootDir, check: true }),
    [],
  );
});

test("an already-synced catalog is left byte-for-byte unchanged", async (t) => {
  const f = await fixture(t, [entry("example", "Current copy")]);
  await f.source("example", "Current copy\n");
  const before = await readFile(f.catalogPath, "utf8");
  assert.deepEqual(await syncMarketplaceOverviews({ rootDir: f.rootDir }), []);
  assert.equal(await readFile(f.catalogPath, "utf8"), before);
});

test("missing or invalid later sources cannot partially update the catalog", async (t) => {
  const f = await fixture(t, [entry("one"), entry("two")]);
  await f.source("one", "Updated\n");
  const before = await readFile(f.catalogPath, "utf8");
  await assert.rejects(
    syncMarketplaceOverviews({ rootDir: f.rootDir }),
    /plugins\/two\/PLUGIN_OVERVIEW\.md/,
  );
  assert.equal(await readFile(f.catalogPath, "utf8"), before);
  await f.source("two", " \n\t\n");
  await assert.rejects(
    syncMarketplaceOverviews({ rootDir: f.rootDir }),
    /two.*empty/i,
  );
  assert.equal(await readFile(f.catalogPath, "utf8"), before);
});

for (const kind of ["file", "plugin directory"]) {
  test(`rejects outside-repository ${kind} symlinks without partially updating the catalog`, async (t) => {
    const f = await fixture(t, [entry("one"), entry("two")]);
    const outside = await fixture(t);
    await f.source("one", "Updated copy");
    const target = join(outside.rootDir, "PLUGIN_OVERVIEW.md");
    await writeFile(target, "Synthetic private data");
    const pluginDir = join(f.rootDir, "plugins", "two");
    if (kind === "file") {
      await mkdir(pluginDir);
      await symlink(target, join(pluginDir, "PLUGIN_OVERVIEW.md"), "file");
    } else {
      await symlink(outside.rootDir, pluginDir, "dir");
    }
    const before = await readFile(f.catalogPath, "utf8");
    for (const check of [false, true]) {
      await assert.rejects(
        syncMarketplaceOverviews({ rootDir: f.rootDir, check }),
        /two.*must resolve within its plugin directory/,
      );
      assert.equal(await readFile(f.catalogPath, "utf8"), before);
    }
  });
}

test("rejects an outside-repository plugins directory symlink in both modes", async (t) => {
  const f = await fixture(t);
  const outside = await fixture(t);
  await outside.source("example", "Synthetic private data");
  await symlink(
    join(outside.rootDir, "plugins"),
    join(f.rootDir, "plugins"),
    "dir",
  );
  const before = await readFile(f.catalogPath, "utf8");
  for (const check of [false, true]) {
    await assert.rejects(
      syncMarketplaceOverviews({ rootDir: f.rootDir, check }),
      /example.*must resolve within its plugin directory/,
    );
    assert.equal(await readFile(f.catalogPath, "utf8"), before);
  }
});

test("rejects a sibling plugin target with a similar directory prefix", async (t) => {
  const f = await fixture(t, [entry("one"), entry("two")]);
  await f.source("one", "Updated copy");
  await f.source("two-other", "Other plugin copy");
  const pluginDir = join(f.rootDir, "plugins", "two");
  await mkdir(pluginDir);
  await symlink(
    join(f.rootDir, "plugins", "two-other", "PLUGIN_OVERVIEW.md"),
    join(pluginDir, "PLUGIN_OVERVIEW.md"),
    "file",
  );
  const before = await readFile(f.catalogPath, "utf8");
  for (const check of [false, true]) {
    await assert.rejects(
      syncMarketplaceOverviews({ rootDir: f.rootDir, check }),
      /two.*must resolve within its plugin directory/,
    );
    assert.equal(await readFile(f.catalogPath, "utf8"), before);
  }
});

test("allows a source symlink whose target stays inside its owning plugin", async (t) => {
  const f = await fixture(t);
  const pluginDir = join(f.rootDir, "plugins", "example");
  await mkdir(join(pluginDir, "docs"), { recursive: true });
  await writeFile(join(pluginDir, "docs", "copy.md"), "Safe copy\n");
  await symlink(
    join("docs", "copy.md"),
    join(pluginDir, "PLUGIN_OVERVIEW.md"),
    "file",
  );
  assert.deepEqual(await syncMarketplaceOverviews({ rootDir: f.rootDir }), [
    "example",
  ]);
  assert.equal(
    JSON.parse(await readFile(f.catalogPath, "utf8")).plugins[0].overview,
    "Safe copy",
  );
  assert.deepEqual(
    await syncMarketplaceOverviews({ rootDir: f.rootDir, check: true }),
    [],
  );
});

test("supports a symlinked repository root", async (t) => {
  const f = await fixture(t);
  const parent = await fixture(t);
  await f.source("example", "Safe copy");
  const alias = join(parent.rootDir, "checkout");
  await symlink(f.rootDir, alias, "dir");
  assert.deepEqual(await syncMarketplaceOverviews({ rootDir: alias }), [
    "example",
  ]);
  assert.deepEqual(
    await syncMarketplaceOverviews({ rootDir: alias, check: true }),
    [],
  );
});

test("enforces the 4000-character limit using Unicode code points", async (t) => {
  const f = await fixture(t);
  await f.source("example", `${"🔎".repeat(4000)}\n`);
  await syncMarketplaceOverviews({ rootDir: f.rootDir });
  const before = await readFile(f.catalogPath, "utf8");
  await f.source("example", "x".repeat(4001));
  await assert.rejects(
    syncMarketplaceOverviews({ rootDir: f.rootDir }),
    /4000/,
  );
  assert.equal(await readFile(f.catalogPath, "utf8"), before);
});

test("fills missing generated overview fields", async (t) => {
  const missing = entry("example");
  delete missing.overview;
  const f = await fixture(t, [missing]);
  await f.source("example", "New copy");
  await syncMarketplaceOverviews({ rootDir: f.rootDir });
  assert.equal(
    JSON.parse(await readFile(f.catalogPath, "utf8")).plugins[0].overview,
    "New copy",
  );
});

for (const id of ["../outside", "a/b", "", "UPPER_CASE"]) {
  test(`rejects unsafe plugin id ${JSON.stringify(id)} before reading sources`, async (t) => {
    const f = await fixture(t, [entry(id)]);
    await assert.rejects(
      syncMarketplaceOverviews({ rootDir: f.rootDir }),
      /invalid plugin id/i,
    );
  });
}

test("the CLI checks this repository from another directory and rejects unknown arguments", async (t) => {
  const f = await fixture(t);
  const run = promisify(execFile);
  const script = fileURLToPath(
    new URL("./sync-marketplace-overviews.mjs", import.meta.url),
  );
  const result = await run(process.execPath, [script, "--check"], {
    cwd: f.rootDir,
  });
  assert.match(result.stdout, /in sync/);
  await assert.rejects(
    run(process.execPath, [script, "--unknown"], { cwd: f.rootDir }),
    (error) => error.code === 1 && /Usage:/.test(error.stderr),
  );
});

test("catalog screenshots reference existing repository image assets", async () => {
  const rootDir = fileURLToPath(new URL("../", import.meta.url));
  const catalog = JSON.parse(
    await readFile(join(rootDir, "marketplace.json"), "utf8"),
  );
  for (const plugin of catalog.plugins) {
    const screenshots = plugin.screenshots ?? [];
    assert.ok(Array.isArray(screenshots) && screenshots.length <= 6);
    for (const screenshot of screenshots) {
      const prefix =
        "https://raw.githubusercontent.com/fgrehm/bb-marketplace/main/";
      assert.ok(
        screenshot.startsWith(`${prefix}plugins/${plugin.id}/`),
        screenshot,
      );
      const relative = screenshot.slice(prefix.length);
      assert.ok(
        [".png", ".jpg", ".jpeg", ".webp"].includes(extname(relative)),
        screenshot,
      );
      assert.ok((await stat(join(rootDir, relative))).isFile(), screenshot);
    }
  }
});

test("rejects duplicate IDs and unsupported catalog versions", async (t) => {
  const f = await fixture(t, [entry("example"), entry("example")]);
  await f.source("example", "Copy");
  await assert.rejects(
    syncMarketplaceOverviews({ rootDir: f.rootDir }),
    /duplicate/i,
  );
  await writeFile(
    f.catalogPath,
    JSON.stringify({ ...f.catalog, schemaVersion: 1 }),
  );
  await assert.rejects(syncMarketplaceOverviews({ rootDir: f.rootDir }), /v2/i);
});

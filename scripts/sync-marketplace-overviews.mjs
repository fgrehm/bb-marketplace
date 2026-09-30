import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

export async function syncMarketplaceOverviews({
  rootDir = repositoryRoot,
  check = false,
} = {}) {
  const canonicalRoot = await realpath(rootDir);
  const catalogPath = join(canonicalRoot, "marketplace.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  if (catalog.schemaVersion !== 2 || !Array.isArray(catalog.plugins)) {
    throw new Error(
      "marketplace.json must be a v2 catalog with a plugins array.",
    );
  }

  const seen = new Set();
  const changed = [];
  for (const entry of catalog.plugins) {
    const id = entry?.id;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
      throw new Error(`Invalid plugin id: ${JSON.stringify(id)}`);
    }
    if (seen.has(id)) throw new Error(`Duplicate marketplace plugin id: ${id}`);
    seen.add(id);

    const pluginDir = join(canonicalRoot, "plugins", id);
    const sourcePath = await realpath(join(pluginDir, "PLUGIN_OVERVIEW.md"));
    const relativeSourcePath = relative(pluginDir, sourcePath);
    if (
      isAbsolute(relativeSourcePath) ||
      relativeSourcePath === ".." ||
      relativeSourcePath.startsWith(`..${sep}`)
    ) {
      throw new Error(
        `${id}: PLUGIN_OVERVIEW.md must resolve within its plugin directory.`,
      );
    }
    const overview = (await readFile(sourcePath, "utf8"))
      .replace(/^\uFEFF/u, "")
      .replace(/\r\n?/gu, "\n")
      .replace(/^\n+/u, "")
      .trimEnd();
    if (!overview.trim())
      throw new Error(`${id}: PLUGIN_OVERVIEW.md is empty.`);
    if ([...overview].length > 4000) {
      throw new Error(
        `${id}: PLUGIN_OVERVIEW.md must be at most 4000 characters.`,
      );
    }
    if (entry.overview !== overview) {
      entry.overview = overview;
      changed.push(id);
    }
  }

  if (changed.length) {
    if (check) {
      throw new Error(
        `marketplace.json overviews are out of sync: ${changed.join(", ")}. Run node scripts/sync-marketplace-overviews.mjs.`,
      );
    }
    // Validate every source before writing, so invalid later entries cannot leave a partial update.
    await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  }
  return changed;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
      throw new Error(
        "Usage: node scripts/sync-marketplace-overviews.mjs [--check]",
      );
    }
    const changed = await syncMarketplaceOverviews({
      check: args[0] === "--check",
    });
    console.log(
      changed.length
        ? `Updated overviews: ${changed.join(", ")}`
        : "Marketplace overviews are in sync.",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

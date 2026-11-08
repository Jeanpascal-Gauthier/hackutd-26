import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function probe(envFile: string | null, inherited: Record<string, string> = {}) {
  const directory = resolve(mkdtempSync(join(tmpdir(), "firewatch-env-")));
  try {
    const modulePath = join(directory, "server", "src", "environment.mjs");
    mkdirSync(dirname(modulePath), { recursive: true });
    // The bootstrap uses standard JS syntax: exercise the actual source in an isolated repo.
    writeFileSync(modulePath, readFileSync(new URL("../environment.ts", import.meta.url)));
    if (envFile !== null) writeFileSync(join(directory, ".env"), envFile);
    const cwd = join(directory, "unrelated-working-directory");
    mkdirSync(cwd);
    const env = { ...process.env };
    delete env.GEOAPIFY_API_KEY;
    delete env.MOCK;
    Object.assign(env, inherited);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      await import(${JSON.stringify(pathToFileURL(modulePath).href)});
      console.log(JSON.stringify({ key: process.env.GEOAPIFY_API_KEY ?? null, mock: process.env.MOCK ?? null }));
    `], { cwd, env, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as { key: string | null; mock: string | null };
  } finally {
    assert.equal(dirname(directory), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("firewatch-env-"));
    rmSync(directory, { recursive: true, force: true });
  }
}

test("server bootstrap loads the repo .env without CLI flags, independent of working directory", () => {
  assert.deepEqual(probe("GEOAPIFY_API_KEY=fixture-key\nMOCK=1\n"), { key: "fixture-key", mock: "1" });
});

test("server bootstrap preserves explicitly supplied environment variables", () => {
  assert.deepEqual(probe("GEOAPIFY_API_KEY=file-key\nMOCK=1\n", { GEOAPIFY_API_KEY: "inherited-key", MOCK: "0" }),
    { key: "inherited-key", mock: "0" });
});

test("server bootstrap permits a missing .env", () => {
  assert.deepEqual(probe(null), { key: null, mock: null });
});

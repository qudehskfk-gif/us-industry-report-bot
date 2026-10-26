import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { IndustryStore } from "../agent/lib/industry-store.ts";
import { initializeGithubState, saveGithubState } from "../agent/lib/github-state.ts";

test("일회용 실행기가 바뀌어도 Git 상태 브랜치에서 중복 방지 이력을 복원합니다", () => {
  const dir = mkdtempSync(join(tmpdir(), "report-github-state-"));
  const remote = join(dir, "remote.git");
  const first = join(dir, "first"); const second = join(dir, "second");
  const vars = ["STATE_REPO_DIR", "STATE_PATH", "GITHUB_REPOSITORY", "GH_TOKEN", "GIT_CONFIG_GLOBAL"];
  const previous = new Map(vars.map(k => [k, process.env[k]]));
  let store: IndustryStore | undefined;
  try {
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    const config = join(dir, "gitconfig");
    writeFileSync(config, `[url "${pathToFileURL(remote).href}"]\n\tinsteadOf = https://github.com/example/report-bot.git\n`);
    process.env.GIT_CONFIG_GLOBAL = config;
    process.env.GITHUB_REPOSITORY = "example/report-bot";
    process.env.GH_TOKEN = "dummy-test-token-only";
    process.env.STATE_REPO_DIR = first; process.env.STATE_PATH = join(first, "deliveries.sqlite");
    assert.equal(initializeGithubState().restored, false);
    store = new IndustryStore(process.env.STATE_PATH);
    assert.equal(store.claimDay("2026-10-26"), true);
    writeFileSync(join(first, ".env"), "PRIVATE_TEST_VALUE=must-not-be-pushed\n");
    writeFileSync(join(first, "original.pdf"), "%PDF-must-not-be-pushed");
    saveGithubState();
    const files = execFileSync("git", ["--git-dir", remote, "ls-tree", "--name-only", "bot-state"], { encoding: "utf8" }).trim().split("\n").sort();
    assert.deepEqual(files, [".gitignore", "deliveries.sqlite", "state-format.json"]);
    store.close(); store = undefined;
    process.env.STATE_REPO_DIR = second; process.env.STATE_PATH = join(second, "deliveries.sqlite");
    assert.equal(initializeGithubState().restored, true);
    store = new IndustryStore(process.env.STATE_PATH);
    assert.equal(store.claimDay("2026-10-26"), false);
    assert.equal(store.claimDay("2026-10-27"), true);
    saveGithubState();
    execFileSync("git", ["-C", second, "remote", "set-url", "origin", join(dir, "missing.git")]);
    assert.throws(() => saveGithubState(), error => {
      assert.ok(error instanceof Error); assert.ok(!error.message.includes("dummy-test-token-only")); return true;
    });
  } finally {
    store?.close();
    for (const key of vars) { const value = previous.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(dir, { recursive: true, force: true });
  }
});

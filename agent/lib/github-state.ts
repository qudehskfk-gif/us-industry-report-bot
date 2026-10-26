import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

function settings() {
  const dir = process.env.STATE_REPO_DIR;
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!dir || !repository || !token || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("GitHub 상태 보관 설정이 없습니다.");
  if (resolve(process.env.STATE_PATH || "") !== join(resolve(dir), "deliveries.sqlite")) throw new Error("상태 파일은 전용 상태 저장 폴더 안에 있어야 합니다.");
  return { dir: resolve(dir), repository, token };
}

function git(args: string[], dir: string, token: string): string {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_TRACE: "0", GIT_CURL_VERBOSE: "0",
        GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` },
    });
  } catch { throw new Error("GitHub 상태 보관 요청이 실패했습니다. 저장소 권한과 연결을 확인해 주세요."); }
}

export function initializeGithubState() {
  const { dir, repository, token } = settings();
  if (existsSync(join(dir, ".git"))) throw new Error("상태 폴더가 이미 초기화되어 있습니다.");
  mkdirSync(dir, { recursive: true });
  git(["init", "--initial-branch=bot-state"], dir, token);
  git(["remote", "add", "origin", `https://github.com/${repository}.git`], dir, token);
  const found = git(["ls-remote", "--heads", "origin", "refs/heads/bot-state"], dir, token).trim();
  if (found) {
    git(["fetch", "--depth=1", "origin", "refs/heads/bot-state"], dir, token);
    git(["checkout", "-B", "bot-state", "FETCH_HEAD"], dir, token);
  }
  git(["config", "user.name", "report-bot[bot]"], dir, token);
  git(["config", "user.email", "report-bot@users.noreply.github.com"], dir, token);
  writeFileSync(join(dir, ".gitignore"), "*.sqlite-wal\n*.sqlite-shm\n");
  writeFileSync(join(dir, "state-format.json"), JSON.stringify({ version: 1, database: "deliveries.sqlite" }) + "\n");
  return { restored: !!found };
}

export function saveGithubState() {
  const { dir, token } = settings();
  const database = join(dir, "deliveries.sqlite");
  if (!existsSync(database)) throw new Error("보관할 상태 파일이 없습니다.");
  const db = new DatabaseSync(database);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (Number(checkpoint?.busy || 0)) throw new Error("상태 파일 체크포인트를 완료하지 못했습니다.");
  } finally { db.close(); }
  // Only these three files can leave the runner; no .env, token, chat ID or PDFs.
  git(["add", "--", "deliveries.sqlite", ".gitignore", "state-format.json"], dir, token);
  const changed = git(["diff", "--cached", "--name-only"], dir, token).trim();
  if (changed) git(["commit", "-m", "Update report notification state"], dir, token);
  git(["push", "origin", "HEAD:refs/heads/bot-state"], dir, token);
}

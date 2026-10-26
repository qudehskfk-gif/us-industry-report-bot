import { initializeGithubState, saveGithubState } from "../agent/lib/github-state.ts";
try {
  const action = process.argv[2];
  if (action === "load") console.log(JSON.stringify(initializeGithubState()));
  else if (action === "save") { saveGithubState(); console.log(JSON.stringify({ saved: true })); }
  else throw new Error("load 또는 save를 지정해 주세요.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "GitHub 상태 보관 실패"); process.exitCode = 1;
}

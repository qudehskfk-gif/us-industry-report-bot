import { IndustryStore } from "./industry-store.ts";
import { runIndustryScan } from "./industry-bot.ts";
import { checkCloudStatePath, runScheduledIndustry } from "./cloud-schedule.ts";
import type { Source } from "./industry-sources.ts";
import { saveGithubState } from "./github-state.ts";
import { configuredSources } from "./source-config.ts";

try {
  if (process.env.BOT_SEND_ENABLED !== "true") throw new Error("운영 설정에 BOT_SEND_ENABLED=true가 필요합니다.");
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) throw new Error("텔레그램 연결 정보를 운영 환경에 설정해 주세요.");
  const statePath = process.env.STATE_PATH || "/data/deliveries.sqlite";
  checkCloudStatePath(statePath, !!process.env.RAILWAY_ENVIRONMENT_ID, process.env.RAILWAY_VOLUME_MOUNT_PATH);
  process.env.STATE_PATH = statePath;
  const names = configuredSources();
  const maxPages = Number(process.env.INDUSTRY_MAX_PAGES || 10);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error("INDUSTRY_MAX_PAGES 설정을 확인해 주세요.");
  const store = new IndustryStore(statePath);
  try {
    const github = process.env.GITHUB_ACTIONS === "true";
    const result = await runScheduledIndustry({ store, sources: names as Source[], maxPages,
      initializeOnly: process.env.RUN_MODE === "initialize",
      allowLate: github && process.env.GITHUB_EVENT_NAME === "schedule",
      scan: () => runIndustryScan(true, { checkpoint: github ? async () => { saveGithubState(); } : undefined }),
    });
    console.log(JSON.stringify({ event: "daily_industry_reports", ...result }));
    if (["partial", "failed", "baseline_error"].includes(result.status) || result.baselineErrors.length) process.exitCode = 1;
  } finally { store.close(); }
} catch (error) {
  console.error(error instanceof Error ? error.message : "클라우드 예약 실행 설정 오류");
  process.exitCode = 1;
}

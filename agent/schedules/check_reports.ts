import { defineSchedule } from "eve/schedules";
import { runConfiguredScan } from "../lib/report-bot.ts";

export default defineSchedule({
  // 08:00 UTC = 17:00 Asia/Seoul, every day including weekends.
  cron: "0 8 * * *",
  async run() {
    if (process.env.BOT_SEND_ENABLED !== "true") return;
    const result = await runConfiguredScan(true);
    console.log(JSON.stringify({ event: "report_scan", ...result }));
    if (result.errors || result.uncertain || result.sourceErrors.length || result.coverageWarnings.length) throw new Error("리포트 수집 또는 전송 상태를 확인해야 합니다.");
  },
});

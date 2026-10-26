import { kstDay, runConfiguredScan, sendTelegram } from "./report-bot.ts";
import { processIndustry } from "./industry-bot.ts";
import { IndustryStore } from "./industry-store.ts";
const args = new Set(process.argv.slice(2));
try {
  for (const arg of args) if (!["--demo", "--send", "--status", "--test-telegram"].includes(arg)) throw new Error(`지원하지 않는 옵션: ${arg}`);
  if (args.has("--demo")) {
    if (args.has("--send")) throw new Error("데모는 전송하지 않습니다.");
    const store = new IndustryStore();
    try {
      console.log(JSON.stringify(await processIndustry([{
        source: "naver", sourceId: "synthetic-demo", published: kstDay(), category: "산업", code: "",
        broker: "하나증권", author: "가상 데모 작성자", title: "가상 데모: 미국 반도체 밸류체인 구조 변화", sector: "반도체",
        sourceUrl: "https://stock.naver.com/research/industry", url: "https://stock.naver.com/research/industry",
        coverText: "Industry In-Depth Report. 산업 구조와 수요공급을 심층 분석합니다.", pages: 70,
      }], { store, live: false, inspect: async r => r }), null, 2));
    } finally { store.close(); }
  } else if (args.has("--test-telegram")) {
    if (process.env.BOT_SEND_ENABLED !== "true") throw new Error("BOT_SEND_ENABLED=true 설정이 필요합니다.");
    const messageId = await sendTelegram("📚 산업 In-Depth 리포트 알림봇 연결 테스트입니다. 이 메시지는 실제 리포트 알림이 아닙니다.");
    console.log(JSON.stringify({ testMessageSent: true, messageId }));
  } else if (args.has("--status")) {
    const store = new IndustryStore(process.env.STATE_PATH || "./data/deliveries.sqlite");
    try { console.log(JSON.stringify(store.status(), null, 2)); } finally { store.close(); }
  } else {
    const result = await runConfiguredScan(args.has("--send"));
    console.log(JSON.stringify(result, null, 2));
    if (result.errors || result.uncertain || result.sourceErrors.length || result.coverageWarnings.length) process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "실행 오류");
  process.exitCode = 1;
}

import { defineTool } from "eve/tools";
import { z } from "zod";
import { runConfiguredScan } from "../lib/report-bot.ts";

export default defineTool({
  description: "한경·네이버 및 공개 접근이 검증된 국내 증권사 8곳에서 미국 산업·종목 관련 산업 심층 리포트를 선별해 미리 봅니다. 실제 전송이나 유료 AI 호출은 하지 않습니다.",
  inputSchema: z.object({}),
  async execute() { return runConfiguredScan(false); },
});

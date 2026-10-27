import { defineTool } from "eve/tools";
import { z } from "zod";
import { runConfiguredScan } from "../lib/report-bot.ts";

export default defineTool({
  description: "검증된 공개 목록·채널에서 미국 산업·종목 관련 PDF 10쪽 이상 산업 리포트를 선별해 미리 봅니다. 심층 표기는 필요하지 않습니다. 실제 전송이나 유료 AI 호출은 하지 않습니다.",
  inputSchema: z.object({}),
  async execute() { return runConfiguredScan(false); },
});

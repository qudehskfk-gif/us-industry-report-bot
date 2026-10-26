import { collectSource, inspectPdf } from "../agent/lib/industry-sources.ts";
import { PUBLIC_CHANNELS, isChannelSource, type ChannelSource } from "../agent/lib/public-channels.ts";
import { configuredSources } from "../agent/lib/source-config.ts";
import { classifyIndustry } from "../agent/lib/industry-filter.ts";
import { classifyUsFocus } from "../agent/lib/industry-focus.ts";
import { publicError } from "../agent/lib/public-http.ts";
import { mkdir, writeFile, appendFile } from "node:fs/promises";

// Retrieval proof only: no Telegram sender, bot token, or chat ID is used.
const requested = process.env.PUBLIC_CHANNEL_SOURCES;
const selected = requested ? configuredSources(requested) : Object.keys(PUBLIC_CHANNELS);
if (selected.some(source => !isChannelSource(source))) throw new Error("공개 채널 출처 이름만 지정해 주세요.");
const sources = selected as ChannelSource[];
const results: Record<string, unknown>[] = [];
for (let index = 0; index < sources.length; index += 2) {
  const batch = await Promise.all(sources.slice(index, index + 2).map(async source => {
    try {
      const list = await collectSource(source, { maxPages: 2 });
      const priority = [...list.reports].sort((a, b) => {
        const score = (r: typeof a) => classifyIndustry(r).status === "eligible" ? 0 : r.category === "산업" && /인[\s·-]*뎁스|\bin[ -]*depth\b|심층/iu.test(r.excerpt || "") ? 1 : r.category === "산업" && classifyIndustry(r).status !== "excluded" ? 2 : 3;
        return score(a) - score(b) || b.published.localeCompare(a.published);
      });
      let pdf: Record<string, unknown> | undefined;
      const errors: { id: string; error: string }[] = [];
      for (const candidate of priority.slice(0, 4)) {
        try {
          const original = await inspectPdf(candidate);
          pdf = { id: original.sourceId, title: original.title, broker: original.broker, sourceUrl: original.sourceUrl,
            pdfUrl: original.pdfUrl, pages: original.pages, bytes: original.pdfBytes!.length, sha256: original.pdfHash,
            depth: classifyIndustry(original), usFocus: classifyUsFocus(original) };
          break;
        } catch (error) { errors.push({ id: candidate.sourceId, error: publicError(error) }); }
      }
      return { source, broker: PUBLIC_CHANNELS[source].broker, status: pdf ? "verified" : "pdf_unverified",
        reports: list.reports.length, industryReports: list.reports.filter(r => r.category === "산업").length,
        ...(pdf ? { pdf } : {}), errors, moreHistory: list.truncated };
    } catch (error) { return { source, status: "failed", error: publicError(error) }; }
  }));
  for (const item of batch) { results.push(item); console.log(JSON.stringify({ event: "public_channel_check", ...item })); }
}
await mkdir("data", { recursive: true });
await writeFile("data/public-channel-check.json", JSON.stringify({ checkedAt: new Date().toISOString(), telegramSent: false, results }, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = results.map(item => {
    const pdf = item.pdf as { pages: number; bytes: number } | undefined;
    return `| ${item.broker || item.source} | ${item.status} | ${item.reports || 0} | ${pdf ? `${pdf.pages}쪽 / ${pdf.bytes} bytes` : "미확인"} |`;
  });
  await appendFile(process.env.GITHUB_STEP_SUMMARY, [
    "## 공개 채널 원문 검증", "", "텔레그램 발송 없이 목록과 PDF 전체 다운로드·발행사 확인만 검사했습니다.",
    "접근 시험 자료가 미국 산업 In-Depth 발송 조건을 충족한다는 의미는 아닙니다.", "",
    "| 증권사 | 결과 | 목록 게시물 | 검증 PDF |", "| --- | --- | ---: | --- |", ...lines, "",
  ].join("\n"));
}
if (results.some(item => item.status !== "verified")) process.exitCode = 1;

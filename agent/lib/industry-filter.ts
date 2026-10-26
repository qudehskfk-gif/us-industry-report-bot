import { createHash } from "node:crypto";
import { compact } from "./report-bot.ts";
import type { IndustryReport } from "./industry-sources.ts";
import { SOURCE_NAMES } from "./source-config.ts";

export type Decision = { status: "eligible" | "excluded" | "review"; reason: string };
const depth = /\bin[\s\-‐‑–—_]*depth\b|\bdeep[\s\-_]*dive\b|인[\s·\-]*뎁스|딥\s*다이브|심층(?:\s*(?:분석|리포트|보고서|연구))?/iu;
const routine = /\b(?:daily|weekly|bi[ -]?weekly|morning|spot|brief|comment)\b|데일리|위클리|일간|주간|모닝|스팟|단신/iu;
const company = /\bcompany\s*(?:in[ -]?depth|deep[ -]?dive|update|brief|note|report|analysis|initiation)\b|기업\s*(?:심층|분석\s*보고서)/iu;

export function classifyIndustry(report: IndustryReport): Decision {
  if (!["산업", "산업분석", "업종분석"].includes(report.category)) return { status: "excluded", reason: "산업분석 게시물이 아닙니다." };
  const front = (report.coverText || "").slice(0, 1400);
  if (company.test(front)) return { status: "excluded", reason: "표지에서 개별 기업 분석 유형이 확인됐습니다." };
  if (routine.test(report.title) && !depth.test(report.title)) {
    return { status: "excluded", reason: "일일·주간 동향 또는 짧은 코멘트 유형입니다." };
  }
  const titleMarker = report.title.match(depth)?.[0];
  const coverMarker = (report.coverText || "").match(depth)?.[0];
  if (titleMarker || coverMarker) return { status: "eligible", reason: `${titleMarker ? "제목" : "PDF 앞부분"}의 심층 표기: ${titleMarker || coverMarker}` };
  return { status: "review", reason: "명시적인 In-Depth·Deep Dive·인뎁스·심층 표기가 없어 자동 확정하지 않았습니다." };
}

export function industryKey(report: IndustryReport): string {
  const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const title = report.title.replace(/\[(?:산업분석|산업|in[ -]?depth)\]/giu, "");
  return createHash("sha256").update([report.published, norm(report.broker), norm(title)].join("\n")).digest("hex");
}

const clip = (value: string, length: number) => value.slice(0, length).replace(/[\uD800-\uDBFF]$/u, "");

export function industryFilename(report: IndustryReport): string {
  const stem = compact(`${report.published}_${report.broker}_${report.title}`)
    .replace(/[<>:"/\\|?*\p{Cc}\p{Cf}]/gu, "_").replace(/[. ]+$/u, "");
  let filename = "";
  for (const c of stem) {
    if (Buffer.byteLength(filename + c, "utf8") > 180) break;
    filename += c;
  }
  return `${filename || "industry-report"}.pdf`;
}

export function industryCaption(report: IndustryReport, decision: Decision, summary = ""): string {
  const caption = [
    "🇺🇸 국내 증권사 · 미국 산업 In-Depth",
    `산업: ${clip(compact(report.sector || "미분류"), 50)}`,
    `제목: ${clip(compact(report.title), 330)}`,
    `증권사: ${clip(compact(report.broker), 60)} | 발간일: ${report.published}`,
    `등록사이트: ${SOURCE_NAMES[report.source]}`,
    ...(report.pages ? [`분량: ${report.pages}쪽`] : []),
    `선별 근거: ${clip(compact(decision.reason), 110)}`,
    "첨부: PDF 원문",
  ].join("\n");
  return clip(summary ? `${caption}\n\nAI 요약 · 앞 3쪽 기준\n${summary}` : caption, 1000);
}

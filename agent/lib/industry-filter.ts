import { createHash } from "node:crypto";
import { compact } from "./report-bot.ts";
import type { IndustryReport } from "./industry-sources.ts";
import { SOURCE_NAMES } from "./source-config.ts";
import { isChannelSource } from "./public-channels.ts";

export type Decision = { status: "eligible" | "excluded" | "review"; reason: string };
export const MIN_REPORT_PAGES = 10;
export const INDUSTRY_POLICY = "us-industry-pages10-v3";
// An optional title clue for distinguishing company-review templates only.
// A depth label is never required for eligibility or allowed to bypass page count.
const optionalDepthTitle = /\bin[\s\-‐‑–—_]*depth\b|\bdeep[\s\-_]*dive\b|인[\s·\-]*뎁스|딥\s*다이브|심층(?:\s*(?:분석|리포트|보고서|연구))?/iu;
const routine = /\b(?:daily|weekly|bi[ -]?weekly|morning|spot|brief|comment)\b|데일리|위클리|일간|주간|모닝|스팟|단신/iu;
const company = /\bcompany\s*(?:in[ -]?depth|deep[ -]?dive|update|brief|note|report|analysis|initiation)\b|기업\s*(?:심층|분석\s*보고서)/iu;

export function hasMinimumReportPages(report: IndustryReport): boolean {
  return Number.isInteger(report.pages) && (report.pages || 0) >= MIN_REPORT_PAGES;
}

export function classifyIndustry(report: IndustryReport): Decision {
  if (!["산업", "산업분석", "업종분석"].includes(report.category)) return { status: "excluded", reason: "산업분석 게시물이 아닙니다." };
  const post = (report.excerpt || "").slice(0, 12000);
  // Some channel posts omit the company ticker from the title. Recognize the
  // company earnings-review template before downloading, including saved retries.
  // Keep explicit industry/depth titles and avoid judging later company appendices.
  if (isChannelSource(report.source) && /^『[^:：\n]+[:：][^\n]+』$/u.test(report.title) &&
    !optionalDepthTitle.test(report.title) && !/산업|업종|섹터|\bindustry\b|\bsector\b/iu.test(report.title) &&
    /동사/u.test(post.slice(0, 600)) && /\b[1-4]Q\s*\d{2,4}\s*(?:Review|Preview)\b/iu.test(post) &&
    /Valuation\s*&\s*Risk/iu.test(post) && /\bTP\s*[:：]?\s*\d[\d,.]*\s*(?:만\s*)?원/iu.test(post)) {
    return { status: "excluded", reason: "공개 게시물에서 개별 기업 실적 리뷰와 목표주가가 확인됐습니다." };
  }
  const front = (report.coverText || "").slice(0, 1400);
  if (company.test(front)) return { status: "excluded", reason: "표지에서 개별 기업 분석 유형이 확인됐습니다." };
  if (routine.test(report.title)) {
    return { status: "excluded", reason: "일일·주간 동향 또는 짧은 코멘트 유형입니다." };
  }
  if (!Number.isInteger(report.pages) || (report.pages || 0) < 1) {
    return { status: "review", reason: "PDF 원문의 전체 쪽수를 확인해야 합니다." };
  }
  if (!hasMinimumReportPages(report)) {
    return { status: "excluded", reason: `PDF 원문이 ${report.pages}쪽으로 최소 ${MIN_REPORT_PAGES}쪽 미만입니다.` };
  }
  return { status: "eligible", reason: `PDF 원문 전체 분량 ${report.pages}쪽: 최소 ${MIN_REPORT_PAGES}쪽 조건 충족` };
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
    "🇺🇸 국내 증권사 · 미국 산업 리포트",
    `산업: ${clip(compact(report.sector || "미분류"), 50)}`,
    `제목: ${clip(compact(report.title), 330)}`,
    `증권사: ${clip(compact(report.broker), 60)} | ${isChannelSource(report.source) ? "게시일" : "발간일"}: ${report.published}`,
    `등록사이트: ${SOURCE_NAMES[report.source]}`,
    ...(report.pages ? [`분량: ${report.pages}쪽`] : []),
    `선별 근거: ${clip(compact(decision.reason), 110)}`,
    "첨부: PDF 원문",
  ].join("\n");
  return clip(summary ? `${caption}\n\nAI 요약 · 앞 3쪽 기준\n${summary}` : caption, 1000);
}

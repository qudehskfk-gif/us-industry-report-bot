import { DeliveryError, sendTelegram } from "./report-bot.ts";
import type { ScanResult } from "./cloud-schedule.ts";

type SummaryRun = {
  status: string; day: string; scanId?: number; seeded: number;
  baselineErrors: unknown[]; result?: ScanResult;
};
const clean = (value: unknown) => String(value ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
const count = (value: unknown, unit = "건") => typeof value === "number" && Number.isInteger(value) && value >= 0 ? `${value}${unit}` : "확인 불가";
const items = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export function runSummaryMessages(run: SummaryRun): string[] {
  if (!["complete", "partial", "failed", "baseline_error"].includes(run.status)) return [];
  const result = run.result;
  const state: Record<string, string> = { complete: "완료", partial: "일부 문제 발생", failed: "실패", baseline_error: "기준점 확인 실패" };
  const lines = [
    `📊 리포트 실행 결과 · ${clean(run.day)}${run.scanId ? ` #${run.scanId}` : ""}`,
    `실행 상태: ${state[run.status]}`,
    `검토한 리포트: ${count(result?.checked)} (게시물 기준)`,
    `PDF 원문 발송: ${count(result?.sent, "개")}`,
  ];
  if (result) {
    lines.push(`조건 미달 제외: ${count(result.excluded)}`,
      `검토 보류: ${count(result.review)} · 중복: ${count(result.duplicates)}`,
      `처리 오류: ${count(result.errors)} · 전송 결과 확인 필요: ${count(result.uncertain)}`);
    const sourceErrors = items(result.sourceErrors).length;
    const warnings = items(result.coverageWarnings).length;
    if (sourceErrors || warnings) lines.push(`목록 수집 실패: ${sourceErrors}곳 · 수집 범위 경고: ${warnings}건`);
  } else {
    lines.push("실행 중단으로 검토·발송 집계를 확정하지 못했습니다. 0건이라는 뜻이 아닙니다.");
  }
  if (run.baselineErrors.length) lines.push(`기준점 확인 실패: ${run.baselineErrors.length}곳`);
  if (run.seeded) lines.push(`최초 과거 자료 기준점: ${run.seeded}건 (발송 제외)`);
  lines.push("", "조건에 맞지 않아 제외한 리포트");
  const excluded = items(result?.excludedReports).filter((value): value is { title: string; broker?: string; reason?: string } =>
    !!value && typeof value === "object" && typeof (value as { title?: unknown }).title === "string");
  if (excluded.length) excluded.forEach((report, index) => {
    lines.push(`${index + 1}. ${clean(report.title)}${report.broker ? ` [${clean(report.broker)}]` : ""}`,
      `   제외 사유: ${clean(report.reason) || "조건 미달"}`);
  });
  else lines.push(result?.excluded === 0 ? "없음" : "세부 목록을 확인하지 못했습니다.");
  if (result && excluded.length !== result.excluded) lines.push("※ 제외 건수와 세부 목록이 일치하지 않아 실행 로그 확인이 필요합니다.");
  lines.push("", "보류·오류·중복은 조건 미달 제외 목록과 구분합니다. PDF 발송 건수에 이 요약 메시지는 포함하지 않습니다.");

  // Plain text only. Split at a newline when possible and never split a surrogate pair.
  const parts: string[] = []; let text = lines.join("\n");
  while (text.length > 3500) {
    let end = text.lastIndexOf("\n", 3500);
    if (end < 1750) end = 3500;
    if (/[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
    parts.push(text.slice(0, end)); text = text.slice(end);
  }
  parts.push(text);
  return parts.map((part, index) => parts.length > 1 ? `[결과 요약 ${index + 1}/${parts.length}]\n${part}` : part);
}

export async function sendRunSummary(run: SummaryRun, options: {
  sender?: (message: string) => Promise<string>;
  pause?: () => Promise<void>;
} = {}) {
  const messages = runSummaryMessages(run);
  if (!messages.length) return { status: "skipped", parts: 0, sent: 0 };
  let sent = 0;
  try {
    for (const message of messages) {
      if (sent) await (options.pause || (() => new Promise(resolve => setTimeout(resolve, 1100))))();
      await (options.sender || sendTelegram)(message); sent++;
    }
    return { status: "sent", parts: messages.length, sent };
  } catch (error) {
    // Do not retry uncertain sends or expose request URLs or credentials in errors.
    return { status: error instanceof DeliveryError && error.definitive ? "failed" : "uncertain", parts: messages.length, sent };
  }
}

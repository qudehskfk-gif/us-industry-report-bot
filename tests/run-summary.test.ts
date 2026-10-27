import test from "node:test";
import assert from "node:assert/strict";
import { runSummaryMessages, sendRunSummary } from "../agent/lib/run-summary.ts";
import { processIndustry } from "../agent/lib/industry-bot.ts";
import { IndustryStore } from "../agent/lib/industry-store.ts";
import { DeliveryError } from "../agent/lib/report-bot.ts";
import type { IndustryReport } from "../agent/lib/industry-sources.ts";
import type { ScanResult } from "../agent/lib/cloud-schedule.ts";

const scan = (overrides: Partial<ScanResult> = {}): ScanResult => ({ checked: 0, sent: 0, excluded: 0,
  review: 0, duplicates: 0, errors: 0, uncertain: 0, sourceErrors: [], coverageWarnings: [], excludedReports: [], ...overrides });
const run = (result = scan(), status = "complete") => ({ status, day: "2026-10-28", scanId: 12, seeded: 0, baselineErrors: [], result });

test("실제 분류 결과에서 검토·PDF 발송·제외 제목을 요약하고 보류·오류·중복을 섞지 않습니다", async () => {
  const store = new IndustryStore(); let pdfSends = 0;
  const report: IndustryReport = { source: "naver", sourceId: "ok", category: "산업", code: "", sector: "반도체",
    sourceUrl: "https://stock.naver.com/research/industry/1", url: "https://stock.naver.com/research/industry/1",
    published: "2026-10-28", broker: "하나증권", author: "가상", title: "미국 AI 산업 전망", pages: 10, pdfHash: "same-pdf" };
  const reports = [report,
    { ...report, sourceId: "short", title: "미국 반도체 산업의 짧은 자료", pages: 9 },
    { ...report, sourceId: "weekly", title: "미국 산업 Weekly", pages: 20 },
    { ...report, sourceId: "review", title: "쪽수 확인 대기 자료", pages: undefined },
    { ...report, sourceId: "error", title: "PDF 다운로드 오류 자료" },
    { ...report, sourceId: "duplicate", title: "미국 산업의 동일 PDF 재게시" },
  ];
  try {
    store.ingest({ source: "naver", reports, truncated: false }, false);
    const result = await processIndustry(reports, { store, live: true,
      inspect: async r => { if (r.sourceId === "error") throw new Error("다운로드 오류");
        return { ...r, pdfBytes: new TextEncoder().encode("%PDF-test-only") }; },
      sender: async () => String(++pdfSends) });
    assert.equal(result.checked, 6); assert.equal(result.sent, 1); assert.equal(pdfSends, 1);
    assert.equal(result.excluded, 2); assert.equal(result.review, 1); assert.equal(result.errors, 1); assert.equal(result.duplicates, 1);
    assert.deepEqual(result.excludedReports.map(r => r.title), [reports[1].title, reports[2].title]);
    const messages: string[] = [];
    const summary = await sendRunSummary(run(scan(result)), { sender: async text => { messages.push(text); return "summary-id"; } });
    assert.equal(summary.status, "sent"); assert.equal(messages.length, 1);
    const text = messages[0];
    assert.match(text, /검토한 리포트: 6건/u); assert.match(text, /PDF 원문 발송: 1개/u);
    assert.ok(text.includes(reports[1].title)); assert.ok(text.includes(reports[2].title)); assert.match(text, /9쪽/u);
    for (const i of [3, 4, 5]) assert.ok(!text.includes(reports[i].title));
    assert.match(text, /검토 보류: 1건 · 중복: 1건/u); assert.match(text, /처리 오류: 1건/u);
    assert.equal(result.sent, 1); assert.equal(store.status().deliveries.filter(r => r.status === "sent").length, 1);
  } finally { store.close(); }
});

test("새 검토 대상이나 발송이 없어도 실행 완료 요약을 보냅니다", async () => {
  const messages: string[] = [];
  await sendRunSummary(run(), { sender: async text => { messages.push(text); return "1"; } });
  assert.equal(messages.length, 1); assert.match(messages[0], /검토한 리포트: 0건/u);
  assert.match(messages[0], /PDF 원문 발송: 0개/u); assert.match(messages[0], /제외한 리포트\n없음/u);
});

test("제외 목록이 길어도 모든 제목을 Telegram 길이 제한 안에서 이어서 보냅니다", async () => {
  const excludedReports = Array.from({ length: 85 }, (_, i) => ({ title: `자료${i} ` + "반도체😀".repeat(30), broker: "하나증권", reason: "10쪽 미만" }));
  const summary = run(scan({ checked: 85, excluded: 85, excludedReports }));
  const sent: string[] = []; let pauses = 0;
  const result = await sendRunSummary(summary, { sender: async text => { sent.push(text); return String(sent.length); }, pause: async () => { pauses++; } });
  assert.ok(sent.length > 1); assert.equal(result.sent, sent.length); assert.equal(pauses, sent.length - 1);
  for (const message of sent) { assert.ok(message.length <= 4096); assert.ok(!/[\uD800-\uDBFF]$/u.test(message)); }
  const combined = sent.join("\n");
  for (const report of excludedReports) assert.ok(combined.includes(report.title), report.title);
  assert.match(sent[0], /결과 요약 1\//u); assert.ok(sent.at(-1)?.includes(`결과 요약 ${sent.length}/${sent.length}`));
});

test("아주 긴 제목과 이모지도 잘못된 문자로 끊거나 누락하지 않습니다", () => {
  const title = "제목😀".repeat(2000);
  const messages = runSummaryMessages(run(scan({ checked: 1, excluded: 1, excludedReports: [{ title, broker: "하나증권", reason: "제외" }] })));
  const combined = messages.map(text => text.replace(/^\[결과 요약 \d+\/\d+\]\n/u, "")).join("");
  assert.ok(combined.includes(title));
  for (const message of messages) { assert.ok(message.length <= 4096); assert.ok(!/[\uD800-\uDBFF]$/u.test(message)); }
});

test("수집 실패와 집계 미확인은 정상 0건으로 표시하지 않습니다", () => {
  const failed = runSummaryMessages({ status: "failed", day: "2026-10-28", seeded: 0, baselineErrors: [] }).join("");
  assert.match(failed, /검토한 리포트: 확인 불가/u); assert.match(failed, /PDF 원문 발송: 확인 불가/u);
  assert.ok(!failed.includes("발송: 0개")); assert.match(failed, /0건이라는 뜻이 아닙니다/u);
  const partial = runSummaryMessages({ ...run(scan({ sourceErrors: [{ source: "hana" }], coverageWarnings: ["page limit"] }), "partial"), baselineErrors: ["naver"] }).join("");
  assert.match(partial, /목록 수집 실패: 1곳 · 수집 범위 경고: 1건/u); assert.match(partial, /기준점 확인 실패: 1곳/u);
});

test("기준점 초기화와 예약 시각 밖의 무수집 실행에는 Telegram 요약을 보내지 않습니다", async () => {
  for (const status of ["initialized", "outside_window"]) {
    const result = await sendRunSummary(run(scan(), status), { sender: async () => { throw new Error("전송 금지"); } });
    assert.equal(result.status, "skipped"); assert.equal(result.sent, 0);
  }
});

test("요약 전송 실패는 PDF 발송 결과와 분리하고 불확실한 요청을 반복하지 않습니다", async () => {
  for (const error of [new DeliveryError("거절", true), new Error("https://private.invalid/secret-token")]) {
    const input = run(scan({ checked: 1, sent: 1 })); let calls = 0;
    const result = await sendRunSummary(input, { sender: async () => { calls++; throw error; } });
    assert.equal(calls, 1); assert.equal(result.status, error instanceof DeliveryError ? "failed" : "uncertain");
    assert.equal(input.result.sent, 1); assert.ok(!JSON.stringify(result).includes("secret-token"));
  }
});

test("여러 요약 중 일부 전송이 불확실하면 그 부분을 재시도하거나 남은 부분을 보내지 않습니다", async () => {
  const excludedReports = Array.from({ length: 100 }, (_, i) => ({ title: `제외 자료 ${i} ` + "긴 제목 ".repeat(40), broker: "하나증권", reason: "9쪽" }));
  let calls = 0;
  const input = run(scan({ checked: 100, excluded: 100, excludedReports }));
  const result = await sendRunSummary(input, { sender: async () => { if (++calls === 2) throw new Error("연결 종료"); return "1"; }, pause: async () => {} });
  assert.ok(result.parts > 2); assert.equal(result.status, "uncertain"); assert.equal(result.sent, 1); assert.equal(calls, 2);
});

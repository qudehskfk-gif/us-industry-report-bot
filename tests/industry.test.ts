import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { classifyIndustry, INDUSTRY_POLICY, industryCaption, industryFilename } from "../agent/lib/industry-filter.ts";
import { checkedPdfUrl, collectSource, parseNaverPage, resolvePdf, inspectPdf } from "../agent/lib/industry-sources.ts";
import type { IndustryReport } from "../agent/lib/industry-sources.ts";
import { IndustryStore } from "../agent/lib/industry-store.ts";
import { processIndustry, runIndustryScan } from "../agent/lib/industry-bot.ts";
import { DeliveryError, sendTelegram, sendTelegramDocument, parseHankyung } from "../agent/lib/report-bot.ts";

// Existing delivery/state scenarios intentionally use the two original adapters.
process.env.INDUSTRY_SOURCES = "hankyung,naver";

const pdfBytes = new TextEncoder().encode("%PDF-1.7\nattachment-transport-test\n%%EOF");

const r: IndustryReport = {
  source: "naver", sourceId: "1", sourceUrl: "https://stock.naver.com/research/industry/1",
  url: "https://stock.naver.com/research/industry/1", category: "산업", code: "", sector: "반도체",
  title: "미국 반도체 산업의 구조적 변화", broker: "하나증권", author: "예시", published: "2026-10-23",
  coverText: "Industry In-Depth Report\n미국 반도체 밸류체인과 수요공급", pages: 60, pdfHash: "same-document",
};
const payload = { hasNext: false, items: [{ nid: "1", title: r.title, brokerName: r.broker, writeDate: r.published, industryKoreanName: r.sector, analystName: "예시", content: "<p>산업 전반 자료</p>" }] };
const inspect = async (value: IndustryReport) => ({ ...value, coverText: value.coverText ?? r.coverText, pdfBytes: value.pdfBytes ?? pdfBytes });

test("네이버 산업 JSON 목록의 실제 필드 구조를 해석합니다", () => {
  const parsed = parseNaverPage(payload);
  assert.equal(parsed.reports[0].sourceId, "1");
  assert.equal(parsed.reports[0].sector, "반도체");
  assert.equal(parsed.reports[0].category, "산업");
  assert.equal(parsed.hasNext, false);
  assert.throws(() => parseNaverPage({ items: [], hasNext: true }), /NAVER_LAYOUT/);
  assert.throws(() => parseNaverPage({ items: [{ title: "누락" }], hasNext: false }), /NAVER_LAYOUT/);
});
test("네이버 목록은 날짜가 아닌 ID 기준으로 이전 확인 지점까지 읽습니다", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async url => {
    const u = new URL(String(url)); assert.equal(u.pathname, "/api/stockSecurity/researches/v2/industry");
    assert.equal(u.searchParams.get("index"), String(calls));
    const item = { ...payload.items[0], nid: String(2 - calls) }; calls++;
    return Response.json({ items: [item], hasNext: true });
  };
  const result = await collectSource("naver", { fetcher, known: new Set(["1"]) });
  assert.equal(calls, 2); assert.equal(result.reports.length, 2); assert.equal(result.truncated, false);
});
test("네이버 상세 응답에서 PDF 주소를 확인하고 다른 ID는 거부합니다", async () => {
  const resolved = await resolvePdf({ ...r, pdfUrl: undefined }, async () => Response.json({ nid: "1", attachUrl: "https://stock.pstatic.net/stock-research/industry/example.pdf" }));
  assert.match(resolved.pdfUrl!, /stock\.pstatic\.net/);
  await assert.rejects(resolvePdf(r, async () => Response.json({ nid: "2" })), /NAVER_DETAIL_LAYOUT/);
  assert.throws(() => checkedPdfUrl("http://127.0.0.1/private"), /PDF_URL/);
});
test("심층 표기 없이도 10쪽 이상인 산업 보고서를 후보로 인정합니다", () => {
  assert.equal(classifyIndustry(r).status, "eligible");
  assert.equal(classifyIndustry({ ...r, coverText: "일반 산업 보고서", title: "미국 전력 산업의 구조 변화", pages: 10 }).status, "eligible");
  assert.equal(classifyIndustry({ ...r, coverText: "", title: "이차전지 산업 전망", pages: 100 }).status, "eligible");
});
test("개별 기업 In-Depth, 주간 동향, 짧은 코멘트는 제외합니다", () => {
  assert.equal(classifyIndustry({ ...r, category: "기업" }).status, "excluded");
  assert.equal(classifyIndustry({ ...r, coverText: "Company In-Depth Report\n개별 기업의 실적 분석" }).status, "excluded");
  assert.equal(classifyIndustry({ ...r, title: "반도체 Weekly: 업황 점검" }).status, "excluded");
  assert.equal(classifyIndustry({ ...r, title: "자동차 주간 동향" }).status, "excluded");
  assert.equal(classifyIndustry({ ...r, title: "미국 반도체 Weekly In-Depth", pages: 20 }).status, "excluded");
});
test("심층 표기가 있어도 9쪽은 제외하고 확인되지 않은 쪽수는 보류합니다", () => {
  assert.equal(classifyIndustry({ ...r, pages: 9, title: "미국 반도체 산업 In-Depth" }).status, "excluded");
  assert.equal(classifyIndustry({ ...r, pages: 10, coverText: "", title: "미국 반도체 전망" }).status, "eligible");
  for (const pages of [undefined, 0, -1, NaN, Infinity, 10.5]) {
    assert.equal(classifyIndustry({ ...r, pages }).status, "review");
  }
});
test("처음 가동한 사이트는 현재 목록을 기준점으로 기록합니다", () => {
  const store = new IndustryStore();
  try {
    assert.deepEqual(store.ingest({ source: "naver", reports: [r], truncated: false }), { seeded: 1, added: 0 });
    assert.equal(store.pending("labels-v1").length, 0);
    assert.equal(store.initialized("naver"), true);
  } finally { store.close(); }
});
test("신규 등록이면 발간일이 과거여도 누락시키지 않습니다", async () => {
  const store = new IndustryStore();
  try {
    store.ingest({ source: "naver", reports: [r], truncated: false });
    const late = { ...r, sourceId: "2", title: "신규 등록된 미국 반도체 산업 In-Depth", published: "2026-10-20" };
    store.ingest({ source: "naver", reports: [late, r], truncated: false });
    let sent = 0;
    const result = await processIndustry(store.pending("labels-v1"), { store, live: true, inspect, sender: async () => String(++sent) });
    assert.equal(result.sent, 1); assert.equal(sent, 1);
  } finally { store.close(); }
});
test("한경과 네이버에 같은 PDF가 올라오면 한 번만 전송합니다", async () => {
  const store = new IndustryStore();
  try {
    const other: IndustryReport = { ...r, source: "hankyung", sourceId: "7", title: "제목 표기가 다른 미국 반도체 산업 In-Depth" };
    store.ingest({ source: "naver", reports: [r], truncated: false }, false);
    store.ingest({ source: "hankyung", reports: [other], truncated: false }, false);
    let sent = 0;
    const result = await processIndustry(store.pending("labels-v1"), { store, live: true, inspect, sender: async () => String(++sent) });
    assert.equal(result.sent, 1); assert.equal(result.duplicates, 1); assert.equal(sent, 1);
    assert.equal(store.status().deliveries.length, 1);
  } finally { store.close(); }
});
test("PDF 확인 오류는 재시도 대기 상태로 남깁니다", async () => {
  const store = new IndustryStore();
  try {
    const unresolved = { ...r, title: "산업 In-Depth", coverText: undefined, pdfHash: undefined };
    store.ingest({ source: "naver", reports: [unresolved], truncated: false }, false);
    const result = await processIndustry([unresolved], { store, live: true, inspect: async () => { throw new Error("다운로드 실패"); }, sender: async () => { throw new Error("전송 금지"); } });
    assert.equal(result.errors, 1);
    assert.equal(store.pending("labels-v1").length, 0);
    assert.equal(store.pending("labels-v1", 20, Date.now() + 11 * 60 * 1000).length, 1);
  } finally { store.close(); }
});
test("새 10쪽 정책은 과거 심층 표기 보류를 다시 검사하고 이미 보낸 이력은 유지합니다", async () => {
  const store = new IndustryStore();
  try {
    const held = { ...r, title: "미국 반도체 산업 전망", coverText: "산업 구조와 전망", pages: 10 };
    const sent = { ...r, sourceId: "already-sent", title: "이전에 보낸 미국 산업 자료", pdfHash: "previous-document" };
    store.ingest({ source: "naver", reports: [held, sent], truncated: false }, false);
    store.save(held, "review", "심층 표기 미확인", "us-industry-labels-v2");
    const claim = store.claim(sent); store.mark(claim.id, "sent", "previous-message");
    store.save(sent, "sent", "이전 전송 성공", "us-industry-labels-v2");
    assert.equal(store.pending("us-industry-labels-v2").length, 0);
    const pending = store.pending(INDUSTRY_POLICY);
    assert.equal(pending.length, 1); assert.equal(pending[0].sourceId, held.sourceId);
    let sends = 0;
    const result = await processIndustry(pending, { store, live: true, inspect, sender: async () => String(++sends) });
    assert.equal(result.sent, 1); assert.equal(sends, 1);
    assert.equal(store.db.prepare("SELECT message_id FROM industry_deliveries WHERE id=?").get(claim.id)?.message_id, "previous-message");
  } finally { store.close(); }
});

test("표기와 쪽수가 없는 신규 자료도 PDF 검사 후 10쪽이면 발송합니다", async () => {
  const store = new IndustryStore(); let inspected = 0; let sends = 0;
  const fresh = { ...r, title: "미국 반도체 산업 전망", coverText: undefined, pages: undefined };
  try {
    store.ingest({ source: "naver", reports: [fresh], truncated: false }, false);
    const result = await processIndustry([fresh], { store, live: true,
      inspect: async value => { inspected++; return { ...value, coverText: "Industry report", pages: 10, pdfBytes }; },
      sender: async () => String(++sends) });
    assert.equal(inspected, 1); assert.equal(result.sent, 1); assert.equal(sends, 1);
  } finally { store.close(); }
});

test("AI가 허용해도 10쪽 미만 또는 쪽수 미확인 자료는 보내지 않습니다", async () => {
  for (const pages of [9, undefined]) {
    const store = new IndustryStore(); let sends = 0; let aiCalls = 0;
    try {
      const result = await processIndustry([{ ...r, pages }], { store, live: true, inspect,
        classifyAi: async () => { aiCalls++; return { status: "eligible", reason: "허용" }; },
        sender: async () => String(++sends) });
      assert.equal(sends, 0); assert.equal(result.sent, 0); assert.equal(aiCalls, 0);
    } finally { store.close(); }
  }
});
test("명시적인 전송 거절은 재시도하고 결과 불명확 전송은 보류합니다", async () => {
  const store = new IndustryStore();
  try {
    store.ingest({ source: "naver", reports: [r], truncated: false }, false);
    await processIndustry([r], { store, live: true, inspect, sender: async () => { throw new DeliveryError("거절", true); } });
    const retry = await processIndustry([r], { store, live: true, inspect, sender: async () => "1" });
    assert.equal(retry.sent, 1);
    const uncertain = { ...r, sourceId: "3", title: "다른 미국 반도체 산업 In-Depth", pdfHash: "other-document" };
    store.ingest({ source: "naver", reports: [uncertain], truncated: false }, false);
    const result = await processIndustry([uncertain], { store, live: true, inspect, sender: async () => { throw new DeliveryError("결과 불명확"); } });
    assert.equal(result.uncertain, 1);
    assert.equal(store.pending("labels-v1", 20, Date.now() + 60 * 60 * 1000).length, 0);
  } finally { store.close(); }
});
test("한 사이트가 차단되어도 다른 사이트의 미리보기는 계속 처리합니다", async () => {
  const result = await runIndustryScan(false, {
    collect: async source => { if (source === "hankyung") throw new Error("차단"); return { source, reports: [r], truncated: false }; }, inspect,
  });
  assert.equal(result.sourceErrors.length, 1);
  assert.equal(result.eligible, 1);
  assert.equal(result.previews.length, 1);
  assert.equal(result.sent, 0);
});
test("두 사이트가 모두 실패하면 0건 성공으로 표시하지 않습니다", async () => {
  await assert.rejects(runIndustryScan(false, { collect: async () => { throw new Error("차단"); }, inspect }), /모든 수집 경로/);
});
test("접근 차단은 빈 목록으로 처리하지 않습니다", () => {
  assert.throws(() => parseHankyung("Block access. 0001"), /SOURCE_BLOCKED/);
});
test("한경 산업 전용 목록의 제목·투자의견 열을 정확하게 구분합니다", () => {
  const html = '<table><tr><th>작성일</th><th>제목</th><th>투자의견</th><th>작성자</th><th>제공출처</th><th>차트</th><th>첨부파일</th></tr><tr><td>2026-10-23</td><td><a href="/analysis/downpdf?report_idx=123">반도체 심층분석</a></td><td>-</td><td>예시</td><td>예시증권</td><td><a href="/chart/view_frame?report_type=IN">차트</a></td><td></td></tr></table>';
  const rows = parseHankyung(html, "산업");
  assert.equal(rows.length, 1); assert.equal(rows[0].title, "반도체 심층분석");
  assert.equal(rows[0].category, "산업"); assert.equal(rows[0].broker, "예시증권");
});
test("한 사이트의 재시도 작업 때문에 다른 사이트의 신규 작업이 밀리지 않습니다", () => {
  const store = new IndustryStore();
  try {
    const old = { ...r, source: "hankyung" as const, sourceId: "2" };
    store.ingest({ source: "hankyung", reports: [old], truncated: false }, false);
    store.save(old, "error", "다운로드 실패");
    store.ingest({ source: "naver", reports: [r], truncated: false }, false);
    assert.equal(store.pending("labels-v1", 1)[0].source, "naver");
    assert.equal(store.pending("labels-v1", 1, Date.now(), ["naver"])[0].source, "naver");
  } finally { store.close(); }
});
test("전송 오류 로그에 봇 토큰을 노출하지 않습니다", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalChat = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_BOT_TOKEN = "fake-secret-for-test";
  process.env.TELEGRAM_CHAT_ID = "0";
  globalThis.fetch = async () => { throw new Error("fake-secret-for-test"); };
  try {
    await assert.rejects(sendTelegram("test"), (error: unknown) => {
      assert.ok(error instanceof DeliveryError);
      assert.ok(!error.message.includes("fake-secret-for-test")); return true;
    });
    await assert.rejects(sendTelegramDocument({ bytes: pdfBytes, filename: "test.pdf", caption: "test" }), (error: unknown) => {
      assert.ok(error instanceof DeliveryError);
      assert.ok(!error.message.includes("fake-secret-for-test")); return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    if (originalChat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = originalChat;
  }
});

test("텔레그램 sendDocument에 원문 바이트와 PDF 파일명을 multipart로 첨부합니다", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalChat = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_BOT_TOKEN = "fake-token";
  process.env.TELEGRAM_CHAT_ID = "123";
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.ok(String(url).endsWith("/sendDocument"));
    assert.equal(init?.method, "POST");
    assert.ok(init?.body instanceof FormData);
    assert.equal(init.body.get("chat_id"), "123");
    assert.equal(init.body.get("caption"), "산업 심층 리포트");
    const file = init.body.get("document");
    assert.ok(file instanceof File);
    assert.equal(file.name, "original.pdf");
    assert.equal(file.type, "application/pdf");
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), pdfBytes);
    return Response.json({ ok: true, result: { message_id: 42 } });
  };
  try {
    assert.equal(await sendTelegramDocument({ bytes: pdfBytes, filename: "original.pdf", caption: "산업 심층 리포트" }), "42");
    assert.equal(calls, 1);
    await assert.rejects(sendTelegramDocument({ bytes: pdfBytes, filename: "x.pdf", caption: "a".repeat(1025) }), /PDF_CAPTION/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    if (originalChat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = originalChat;
  }
});

test("원문 파일이 없으면 제목에 In-Depth가 있어도 링크로 대신 보내지 않습니다", async () => {
  const store = new IndustryStore();
  const marked = { ...r, title: "미국 반도체 산업 In-Depth" };
  try {
    store.ingest({ source: "naver", reports: [marked], truncated: false }, false);
    let calls = 0;
    const result = await processIndustry([marked], { store, live: true,
      inspect: async value => value, sender: async () => { calls++; return "1"; } });
    assert.equal(result.errors, 1); assert.equal(result.sent, 0); assert.equal(calls, 0);
    assert.equal(store.status().deliveries.length, 0);
    assert.equal(store.pending("labels-v1", 20, Date.now() + 11 * 60 * 1000).length, 1);
  } finally { store.close(); }
});

test("DB에 원문 PDF 바이트와 추출한 앞부분을 저장하지 않습니다", () => {
  const store = new IndustryStore();
  const document = { ...r, pdfBytes, analysisText: "PRIVATE_TRANSIENT_BODY" };
  try {
    store.ingest({ source: "naver", reports: [document], truncated: false }, false);
    assert.equal(store.pending("labels-v1")[0].pdfBytes, undefined);
    assert.equal(store.pending("labels-v1")[0].coverText, undefined);
    assert.equal(store.pending("labels-v1")[0].analysisText, undefined);
    store.save(document, "ready", "확인");
    const pending = store.pending("labels-v1")[0];
    assert.equal(pending.pdfBytes, undefined); assert.equal(pending.coverText, undefined);
    assert.equal(pending.analysisText, undefined);
    assert.equal(pending.pdfHash, r.pdfHash);
  } finally { store.close(); }
});

test("전송 파이프라인이 파일과 설명을 하나의 첨부 요청으로 전달합니다", async () => {
  const store = new IndustryStore();
  try {
    store.ingest({ source: "naver", reports: [r], truncated: false }, false);
    const result = await processIndustry([r], { store, live: true, inspect, sender: async document => {
      assert.deepEqual(document.bytes, pdfBytes);
      assert.match(document.filename, /\.pdf$/);
      assert.match(document.caption, /첨부: PDF 원문/);
      return "9";
    } });
    assert.equal(result.sent, 1);
    assert.equal(store.status().deliveries[0].message_id, "9");
  } finally { store.close(); }
});

test("긴 한글 제목의 첨부 설명과 파일명을 허용 크기로 줄입니다", () => {
  const long = { ...r, title: "산업😀심층/자료".repeat(200), broker: "증권사".repeat(100) };
  const caption = industryCaption(long, { status: "eligible", reason: "근거".repeat(100) }, "요약😀".repeat(500));
  const filename = industryFilename(long);
  assert.ok(caption.length <= 1024);
  assert.ok(Buffer.byteLength(filename, "utf8") <= 184);
  assert.ok(!/[<>:"/\\|?*]/u.test(filename));
  assert.ok(!/[\uD800-\uDBFF]$/u.test(caption));
});

test("PDF 텍스트를 검사한 뒤에도 원문 바이트와 체크섬이 보존됩니다", async () => {
  const text = "BT /F1 12 Tf 40 740 Td (Industry In-Depth Report) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const original = new TextEncoder().encode(pdf);
  const inspected = await inspectPdf({ ...r, pdfUrl: "https://stock.pstatic.net/original.pdf" }, async () => new Response(original));
  assert.equal(inspected.pages, 1);
  assert.match(inspected.coverText!, /Industry In-Depth/);
  assert.match(inspected.analysisText!, /Industry In-Depth/);
  assert.deepEqual(inspected.pdfBytes, original);
  assert.equal(inspected.pdfHash, createHash("sha256").update(original).digest("hex"));
});

test("원격 이력 저장에 실패하면 PDF를 전송하지 않고 다음 자료도 중단합니다", async () => {
  const store = new IndustryStore(); let sends = 0;
  try {
    store.ingest({ source: "naver", reports: [r], truncated: false }, false);
    const result = await processIndustry([r, { ...r, sourceId: "second", pdfHash: "second" }], {
      store, live: true, inspect, checkpoint: async () => { throw new Error("Git push 실패"); },
      sender: async () => { sends++; return "1"; },
    });
    assert.equal(result.errors, 1); assert.equal(result.sent, 0); assert.equal(sends, 0); assert.equal(result.checked, 1);
    assert.equal(store.status().deliveries[0].status, "failed");
  } finally { store.close(); }
});

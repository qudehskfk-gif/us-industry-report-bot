import test from "node:test";
import assert from "node:assert/strict";
import { classifyDomesticIssuer, classifyUsFocus } from "../agent/lib/industry-focus.ts";
import { processIndustry } from "../agent/lib/industry-bot.ts";
import { IndustryStore } from "../agent/lib/industry-store.ts";
import { inspectPdf } from "../agent/lib/industry-sources.ts";
import type { IndustryReport } from "../agent/lib/industry-sources.ts";

const report: IndustryReport = {
  source: "naver", sourceId: "us-focus-fixture", category: "산업", code: "", sector: "반도체",
  sourceUrl: "https://stock.naver.com/research/industry/1", url: "https://stock.naver.com/research/industry/1",
  published: "2026-10-26", broker: "삼성증권", author: "가상", title: "반도체 밸류체인 In-Depth",
  coverText: "Industry In-Depth Report", pdfBytes: new TextEncoder().encode("%PDF-fake-test-only"),
};
const usBody = "엔비디아의 데이터센터 매출과 시장 점유율을 분석합니다. 엔비디아는 차세대 제품 출시로 수요가 확대될 것으로 전망됩니다. 경쟁 기업과 비교하면 공급망 확보와 설비투자 계획은 수익성에 중요한 변수입니다. 중장기 실적은 인공지능 서비스 도입과 클라우드 고객의 투자 확대에 따라 성장할 것으로 예상됩니다. 매출 구성과 영업이익 추정, 밸류에이션을 여러 시나리오로 분석하며 향후 경쟁력의 지속 가능성을 판단합니다.";

test("국내 증권사의 현재·이전 이름을 허용하고 외국계·미확인 발행사는 보류합니다", () => {
  for (const broker of ["삼성증권", "NH투자증권", "iM증권", "아이엠증권", "하이투자증권", "DB증권"]) {
    assert.equal(classifyDomesticIssuer({ ...report, broker }).status, "eligible");
  }
  for (const broker of ["Goldman Sachs", "골드만삭스증권 서울지점", "확인되지않은증권"]) {
    assert.equal(classifyDomesticIssuer({ ...report, broker }).status, "review");
  }
});
test("미국 산업 제목과 글로벌 산업 내 미국 종목 분석을 각각 포함합니다", () => {
  assert.equal(classifyUsFocus({ ...report, title: "미국 전력 인프라 심층분석" }).status, "eligible");
  assert.equal(classifyUsFocus({ ...report, analysisText: usBody }).status, "eligible");
  assert.equal(classifyUsFocus({ ...report, title: "글로벌 AI 산업: 엔비디아와 브로드컴" }).status, "eligible");
});
test("시가총액 상위 50개 제한 없이 미국 거래소·티커 표기를 인식합니다", () => {
  for (const name of ["NASDAQ: XYZ", "XYZ US", "XYZ.US", "XYZ.O", "XYZ.OQ", "XYZ.N"]) {
    assert.equal(classifyUsFocus({ ...report, title: `차세대 반도체 산업과 ${name}` }).status, "eligible");
  }
});
test("국내 전용 자료, 미국 금리 언급, 출처·비교표의 종목명만으로 보내지 않습니다", () => {
  for (const value of [
    { title: "국내 조선업 심층분석", analysisText: "국내 조선사 수주잔고를 분석합니다." },
    { title: "미국 금리와 국내 반도체 실적 전망", analysisText: "미국 금리는 국내 수요에 영향을 줍니다." },
    { title: report.title, analysisText: "자료: NVIDIA, Bloomberg\n경쟁사 비교: NVDA, AMD, AAPL" },
    { title: "국내 메타버스 산업 심층분석", analysisText: "가상 공간과 국내 기업 시장." },
  ]) assert.notEqual(classifyUsFocus({ ...report, ...value }).status, "eligible");
});
test("미국 관련성이 부족하면 AI의 심층 판정으로도 실제 전송되지 않습니다", async () => {
  const store = new IndustryStore(); let sends = 0;
  try {
    const domestic = { ...report, title: "국내 조선 산업", coverText: "조선산업 분석" };
    const result = await processIndustry([domestic], { store, live: true, inspect: async r => r,
      classifyAi: async () => ({ status: "eligible", reason: "심층 분석" }), sender: async () => String(++sends) });
    assert.equal(result.review, 1); assert.equal(result.sent, 0); assert.equal(sends, 0);
  } finally { store.close(); }
});
test("미국 종목이 있어도 개별 기업 전용·주간 자료는 제외합니다", async () => {
  const store = new IndustryStore(); let sends = 0;
  try {
    const result = await processIndustry([
      { ...report, title: "엔비디아", coverText: "Company In-Depth Report" },
      { ...report, title: "미국 반도체 Weekly" },
    ], { store, live: true, inspect: async r => r, sender: async () => String(++sends) });
    assert.equal(result.excluded, 2); assert.equal(sends, 0);
  } finally { store.close(); }
});
test("본문에서 미국 종목 분석을 확인한 산업 리포트는 PDF 원문을 첨부합니다", async () => {
  const store = new IndustryStore();
  try {
    const value = { ...report, analysisText: usBody };
    store.ingest({ source: "naver", reports: [value], truncated: false }, false);
    const result = await processIndustry([value], { store, live: true, inspect: async r => r, sender: async document => {
      assert.deepEqual(document.bytes, value.pdfBytes);
      assert.match(document.caption, /미국 종목 분석: NVDA/); return "1";
    } });
    assert.equal(result.sent, 1);
  } finally { store.close(); }
});
test("미확인 발행사는 PDF 수집과 전송 전에 보류합니다", async () => {
  const store = new IndustryStore();
  try {
    const result = await processIndustry([{ ...report, broker: "외국계증권", title: "미국 반도체 In-Depth" }], {
      store, live: true, inspect: async () => { throw new Error("수집하면 안 됩니다"); },
      sender: async () => { throw new Error("전송하면 안 됩니다"); },
    });
    assert.equal(result.review, 1); assert.equal(result.errors, 0); assert.equal(result.sent, 0);
  } finally { store.close(); }
});
test("표지 뒤 4쪽의 미국 종목 분석도 찾으며 표지와 원문 바이트를 보존합니다", async () => {
  const texts = ["Industry In-Depth Report", "Contents", "Industry overview", "NVIDIA revenue is expected to grow. NVIDIA earnings and margin outlook are expected to improve as semiconductor demand expands. Market share and valuation are analyzed across several growth scenarios for the industry."];
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids: string[] = [];
  for (const text of texts) {
    const page = objects.length + 1; const content = page + 1; kids.push(`${page} 0 R`);
    const lines = text.match(/.{1,65}(?:\s|$)/gu) || [text];
    const stream = `BT /F1 10 Tf 12 TL 40 740 Td ${lines.map((line, i) => `${i ? "T* " : ""}(${line}) Tj`).join(" ")} ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${texts.length} >>`;
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const start = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  const original = new TextEncoder().encode(pdf);
  const result = await inspectPdf({ ...report, pdfUrl: "https://stock.pstatic.net/test.pdf" }, async () => new Response(original));
  assert.doesNotMatch(result.coverText!, /NVIDIA/);
  assert.match(result.analysisText!, /NVIDIA/);
  assert.equal(classifyUsFocus(result).status, "eligible");
  assert.deepEqual(result.pdfBytes, original);
});

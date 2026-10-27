import test from "node:test";
import assert from "node:assert/strict";
import { IndustryStore } from "../agent/lib/industry-store.ts";
import { REQUESTED_REVIEW_BATCH, REQUESTED_REVIEWS, sendRequestedReviewBatch } from "../agent/lib/requested-review-batch.ts";
import type { IndustryReport } from "../agent/lib/industry-sources.ts";
import type { TelegramDocument } from "../agent/lib/report-bot.ts";

function fixture() {
  const store = new IndustryStore();
  for (const item of REQUESTED_REVIEWS) {
    const report: IndustryReport = { ...item, title: "검토 보류 자료 " + item.sourceId, published: "2026-10-27",
      category: "산업", broker: "예시증권", author: "", code: "", sector: "산업",
      url: "https://public.example/report", sourceUrl: "https://public.example/report", pages: 3 };
    store.ingest({ source: item.source, reports: [report], truncated: false }, false);
    store.save(report, "review", "심층 표기 미확인", "us-industry-labels-v2");
  }
  return store;
}
const inspect = async (report: IndustryReport) => ({ ...report, pdfBytes: new Uint8Array(Buffer.from("%PDF-test")) });

test("승인한 22개 게시물만 원문 17개로 보내고 다시 실행해도 재발송하지 않습니다", async () => {
  const store = fixture(); const docs: TelegramDocument[] = []; let downloads = 0;
  try {
    const extra: IndustryReport = { source: "hankyung", sourceId: "unapproved", title: "다른 보류 자료", published: "2026-10-27",
      category: "산업", broker: "예시증권", author: "", code: "", sector: "산업", url: "https://public.example/extra", sourceUrl: "https://public.example/extra" };
    store.ingest({ source: "hankyung", reports: [extra], truncated: false }, false);
    store.save(extra, "review", "미국 관련성 부족");
    store.claimDay("2026-10-27"); store.finishDay("2026-10-27", "partial", { sent: 1 });
    const options = { store, approvedBatch: REQUESTED_REVIEW_BATCH, checkpoint: async () => {},
      inspect: async (r: IndustryReport) => { downloads++; return inspect(r); },
      sender: async (doc: TelegramDocument) => { docs.push(doc); return String(docs.length); } };
    const result = await sendRequestedReviewBatch(options);
    assert.equal(result.posts, 22); assert.equal(result.uniquePdfs, 17); assert.equal(result.duplicatePosts, 5);
    assert.equal(result.sent, 17); assert.equal(result.errors.length, 0); assert.equal(result.uncertain.length, 0);
    assert.equal(downloads, 17); assert.equal(docs.length, 17);
    assert.equal(docs.every(doc => doc.caption.includes("심층 표기 보류 자료") && doc.filename.endsWith(".pdf")), true);
    assert.equal(store.db.prepare("SELECT status FROM industry_observations WHERE source_id='unapproved'").get()?.status, "review");
    assert.equal(store.status().scheduledRuns[0].status, "partial");
    const again = await sendRequestedReviewBatch(options);
    assert.equal(again.sent, 0); assert.equal(again.alreadySent, 17); assert.equal(downloads, 17); assert.equal(docs.length, 17);
  } finally { store.close(); }
});

test("승인 문자열이나 저장된 체크섬이 다르면 첫 전송 전에 중단합니다", async () => {
  const store = fixture(); let sends = 0;
  const sender = async () => { sends++; return "1"; };
  try {
    await assert.rejects(sendRequestedReviewBatch({ store, approvedBatch: "not-approved", checkpoint: async () => {}, inspect, sender }), /승인/);
    const item = REQUESTED_REVIEWS.at(-1)!;
    const report = JSON.parse(String(store.db.prepare("SELECT report_json FROM industry_observations WHERE source=? AND source_id=?").get(item.source, item.sourceId)?.report_json));
    report.pdfHash = "changed";
    store.db.prepare("UPDATE industry_observations SET report_json=? WHERE source=? AND source_id=?").run(JSON.stringify(report), item.source, item.sourceId);
    await assert.rejects(sendRequestedReviewBatch({ store, approvedBatch: REQUESTED_REVIEW_BATCH, checkpoint: async () => {}, inspect, sender }), /체크섬/);
    assert.equal(sends, 0); assert.equal(store.status().deliveries.length, 0);
  } finally { store.close(); }
});

test("원문 체크섬이 달라지면 다른 PDF로 대체해 보내지 않습니다", async () => {
  const store = fixture(); let sends = 0;
  try {
    const result = await sendRequestedReviewBatch({ store, approvedBatch: REQUESTED_REVIEW_BATCH, checkpoint: async () => {},
      inspect: async r => ({ ...await inspect(r), pdfHash: "different" }), sender: async () => { sends++; return "1"; } });
    assert.equal(result.sent, 0); assert.equal(result.errors.length, 17); assert.equal(sends, 0);
    assert.equal(store.status().deliveries.length, 0);
  } finally { store.close(); }
});

test("원격 전송 이력을 저장하지 못하면 파일을 보내지 않습니다", async () => {
  const store = fixture(); let sends = 0;
  try {
    const result = await sendRequestedReviewBatch({ store, approvedBatch: REQUESTED_REVIEW_BATCH,
      checkpoint: async () => { throw new Error("checkpoint failed"); }, inspect,
      sender: async () => { sends++; return "1"; } });
    assert.equal(result.sent, 0); assert.equal(result.errors.length, 1); assert.equal(sends, 0);
  } finally { store.close(); }
});

test("전송 결과가 불명확한 PDF는 다음 실행에서 다시 보내지 않습니다", async () => {
  const store = fixture(); let sends = 0;
  try {
    const options = { store, approvedBatch: REQUESTED_REVIEW_BATCH, checkpoint: async () => {}, inspect,
      sender: async () => { sends++; if (sends === 1) throw new Error("connection interrupted"); return String(sends); } };
    const first = await sendRequestedReviewBatch(options);
    assert.equal(first.sent, 16); assert.equal(first.uncertain.length, 1);
    const second = await sendRequestedReviewBatch(options);
    assert.equal(second.sent, 0); assert.equal(second.alreadySent, 16); assert.equal(second.uncertain.length, 1);
    assert.equal(sends, 17);
  } finally { store.close(); }
});

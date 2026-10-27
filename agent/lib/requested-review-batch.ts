import { IndustryStore } from "./industry-store.ts";
import { inspectPdf } from "./industry-sources.ts";
import type { IndustryReport, Source } from "./industry-sources.ts";
import { industryFilename } from "./industry-filter.ts";
import { compact, DeliveryError, sendTelegramDocument } from "./report-bot.ts";
import type { TelegramDocument } from "./report-bot.ts";

export const REQUESTED_REVIEW_BATCH = "review-2026-10-27-depth-22";
// Fixed public report identifiers from the 22 posts explicitly requested by the user.
// This list never selects other reviews or changes the daily selection policy.
export const REQUESTED_REVIEWS: readonly { source: Source; sourceId: string; pdfHash: string }[] = [
  {
    "source": "hankyung",
    "sourceId": "653289",
    "pdfHash": "650ccac854e9eb60703e023832115291a91c8f80aa6cc97971d5ee30b3e5b592"
  },
  {
    "source": "hankyung",
    "sourceId": "653290",
    "pdfHash": "0eb6335f581fd873ebb516116609d0f60ce616e5031ada068df5901f55e6fb0d"
  },
  {
    "source": "hankyung",
    "sourceId": "653291",
    "pdfHash": "b73f1c9a9795126d59738802e0c909f9a33d595406b83cd2895b10aee73fd2c1"
  },
  {
    "source": "hankyung",
    "sourceId": "653292",
    "pdfHash": "33b9e641eaa0bc3e4b4dbe963026fb8986ae58a9530df0030bfdcbf7962205f0"
  },
  {
    "source": "hankyung",
    "sourceId": "653309",
    "pdfHash": "07a8c3ec81e7a6c640d4ec206428a7860bc38582cc0e2324c6d8103efe8f6ecc"
  },
  {
    "source": "hankyung",
    "sourceId": "653321",
    "pdfHash": "51346d7df0979f2dc2b25d8f989174ac06c53a1a1044e97f5535704a2330d110"
  },
  {
    "source": "hankyung",
    "sourceId": "653322",
    "pdfHash": "67c991ddf1c2ee7881b594c2006aa6c77301ddf12230223c808edd5eacca28ad"
  },
  {
    "source": "hankyung",
    "sourceId": "653330",
    "pdfHash": "1c932c2b54c36e0ee54eb6b772e372de20ecbc82fe8ade6690f23bf3f9bdfbdb"
  },
  {
    "source": "hankyung",
    "sourceId": "653335",
    "pdfHash": "ac8a943d896c4e906694bd8cb534b58ae16e85fcaf09a25ffbeaf2960da5673c"
  },
  {
    "source": "kiwoom",
    "sourceId": "KiwoomResearch/24392/51e740dd897c7528",
    "pdfHash": "78bc9397dafe5ebc3d824a56fcf8a718e1f53969b01d13f5fd5fda10f1f78c52"
  },
  {
    "source": "kiwoom",
    "sourceId": "KiwoomResearch/24395/673c9c5c3ba24827",
    "pdfHash": "99246b4c79b19d1363abfa984e55cb076b91da386074c95af94354e0c9533fc6"
  },
  {
    "source": "meritz",
    "sourceId": "meritz_research/44919/2bdf37a1d23b4b57",
    "pdfHash": "30657eb6f6caf84ebb011869e7835465b735f34b8f817ac5b2fa270a35473c2a"
  },
  {
    "source": "naver",
    "sourceId": "46664",
    "pdfHash": "99246b4c79b19d1363abfa984e55cb076b91da386074c95af94354e0c9533fc6"
  },
  {
    "source": "naver",
    "sourceId": "46667",
    "pdfHash": "07a8c3ec81e7a6c640d4ec206428a7860bc38582cc0e2324c6d8103efe8f6ecc"
  },
  {
    "source": "naver",
    "sourceId": "46669",
    "pdfHash": "33b9e641eaa0bc3e4b4dbe963026fb8986ae58a9530df0030bfdcbf7962205f0"
  },
  {
    "source": "naver",
    "sourceId": "46671",
    "pdfHash": "b73f1c9a9795126d59738802e0c909f9a33d595406b83cd2895b10aee73fd2c1"
  },
  {
    "source": "naver",
    "sourceId": "46672",
    "pdfHash": "51346d7df0979f2dc2b25d8f989174ac06c53a1a1044e97f5535704a2330d110"
  },
  {
    "source": "naver",
    "sourceId": "46673",
    "pdfHash": "9366757c137acc0fc2d230c894409b2aae16a4ce02fcdf2b200b818de34b5fca"
  },
  {
    "source": "naver",
    "sourceId": "46674",
    "pdfHash": "f7338e59a14a890aac23426fee31547f86eec7f3580fd78fe0c7b045f774f38b"
  },
  {
    "source": "naver",
    "sourceId": "46675",
    "pdfHash": "abfb60868a55c5af65e811011e8ff7f27db35aeec0ab06555c8025cceef1a41a"
  },
  {
    "source": "naver",
    "sourceId": "46680",
    "pdfHash": "a51a73f43342fc40a09c4efcd6c64cea54f2c545de5b86cb0f9c3e59b8dac49c"
  },
  {
    "source": "naver",
    "sourceId": "46682",
    "pdfHash": "da253ed323ad5c6bf5b51e1e204fd47614cf5684844e903428642fae4660aeb0"
  }
];

function approvedReports(store: IndustryStore) {
  const query = store.db.prepare("SELECT status,report_json FROM industry_observations WHERE source=? AND source_id=?");
  return REQUESTED_REVIEWS.map(item => {
    const row = query.get(item.source, item.sourceId);
    if (!row) throw new Error("REQUEST_BATCH: 승인한 게시물이 상태 이력에 없습니다.");
    const report = JSON.parse(String(row.report_json)) as IndustryReport;
    if (report.source !== item.source || report.sourceId !== item.sourceId ||
        report.pdfHash !== item.pdfHash || report.published !== "2026-10-27") {
      throw new Error("REQUEST_BATCH: 승인한 게시물 또는 PDF 체크섬이 변경됐습니다.");
    }
    return { report, status: String(row.status), expected: item.pdfHash };
  });
}

type Selected = ReturnType<typeof approvedReports>[number];
function updateGroup(store: IndustryStore, rows: Selected[], status: string, reason: string, sent?: IndustryReport) {
  for (const row of rows) {
    if (row.status === "sent" && status === "duplicate") continue;
    const primary = sent && row.report.source === sent.source && row.report.sourceId === sent.sourceId;
    store.save(primary ? sent : row.report, status === "sent" && !primary ? "duplicate" : status,
      reason, REQUESTED_REVIEW_BATCH, status === "error" ? 10 * 60 * 1000 : 0);
  }
}

function caption(report: IndustryReport) {
  return [
    "📎 사용자 요청 · 심층 표기 보류 자료",
    "제목: " + compact(report.title).slice(0, 300),
    "증권사: " + compact(report.broker).slice(0, 60) + " | 일자: " + report.published,
    ...(report.pages ? ["분량: " + report.pages + "쪽"] : []),
    "자동 선별 조건 통과 자료가 아닌, 요청하신 보류 자료의 PDF 원문입니다.",
    "심층 표기와 미국 관련성은 확정하지 않았습니다.",
  ].join("\n").slice(0, 1000);
}

export async function sendRequestedReviewBatch(options: {
  store: IndustryStore; approvedBatch: string; checkpoint: () => Promise<void>;
  inspect?: (r: IndustryReport) => Promise<IndustryReport>;
  sender?: (document: TelegramDocument) => Promise<string>;
  pause?: () => Promise<void>;
}) {
  if (options.approvedBatch !== REQUESTED_REVIEW_BATCH) throw new Error("REQUEST_BATCH: 명시적인 일회성 발송 승인이 필요합니다.");
  // Validate all 22 entries before any state mutation or external send.
  const selected = approvedReports(options.store);
  const groups = new Map<string, Selected[]>();
  for (const row of selected) groups.set(row.expected, [...(groups.get(row.expected) || []), row]);
  const result = {
    batch: REQUESTED_REVIEW_BATCH, posts: selected.length, uniquePdfs: groups.size,
    duplicatePosts: selected.length - groups.size, sent: 0, alreadySent: 0,
    errors: [] as { title: string; reason: string }[],
    uncertain: [] as string[],
  };
  for (const [expected, rows] of groups) {
    const title = rows[0].report.title;
    const existing = options.store.db.prepare("SELECT status FROM industry_deliveries WHERE pdf_hash=?").get(expected);
    if (existing && existing.status !== "failed") {
      if (existing.status === "sent") {
        result.alreadySent++;
        updateGroup(options.store, rows, "duplicate", "기존에 전송한 동일 PDF입니다.");
      } else {
        result.uncertain.push(title);
        updateGroup(options.store, rows, "uncertain", "기존 전송 결과를 확인해야 하므로 다시 보내지 않았습니다.");
      }
      continue;
    }
    let report: IndustryReport | undefined;
    for (const row of rows) {
      try {
        const inspected = await (options.inspect || inspectPdf)(row.report);
        if (inspected.pdfHash !== expected || !inspected.pdfBytes?.length) continue;
        report = inspected; break;
      } catch { /* Try another approved public link for this same PDF only. */ }
    }
    if (!report) {
      result.errors.push({ title, reason: "승인한 공개 PDF를 받거나 체크섬을 확인하지 못했습니다." });
      updateGroup(options.store, rows, "error", "요청 자료 원문 다운로드 또는 체크섬 확인 실패");
      continue;
    }
    const claim = options.store.claim(report);
    if (!claim.acquired) {
      if (claim.status === "sent") result.alreadySent++;
      else result.uncertain.push(title);
      continue;
    }
    updateGroup(options.store, rows, "ready", "사용자가 요청한 보류 자료의 일회성 전송 준비");
    try { await options.checkpoint(); }
    catch {
      options.store.mark(claim.id, "failed");
      updateGroup(options.store, rows, "error", "전송 전 이력 보관 실패로 보내지 않았습니다.");
      result.errors.push({ title, reason: "전송 전 이력 보관 실패" }); break;
    }
    try {
      if (result.sent) await options.pause?.();
      const messageId = await (options.sender || sendTelegramDocument)({
        bytes: report.pdfBytes!, filename: industryFilename(report), caption: caption(report),
      });
      options.store.mark(claim.id, "sent", messageId);
      updateGroup(options.store, rows, "sent", "사용자 요청으로 보류 자료 원문을 일회성 전송했습니다.", report);
      result.sent++;
    } catch (error) {
      const definitive = error instanceof DeliveryError && error.definitive;
      options.store.mark(claim.id, definitive ? "failed" : "uncertain");
      updateGroup(options.store, rows, definitive ? "error" : "uncertain", "요청 자료의 Telegram 전송 결과를 확인해야 합니다.");
      if (definitive) result.errors.push({ title, reason: "Telegram이 전송을 거절했습니다." });
      else result.uncertain.push(title);
    }
    try { await options.checkpoint(); }
    catch { result.errors.push({ title, reason: "전송 후 이력 보관 실패: 재전송 전에 상태 확인 필요" }); break; }
  }
  return result;
}


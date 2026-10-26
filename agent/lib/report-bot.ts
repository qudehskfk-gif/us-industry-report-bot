import { load } from "cheerio";

export type Report = {
  sourceId: string; published: string; category: string; title: string;
  code: string; broker: string; author: string; url: string;
};
export const compact = (s: string) => s.normalize("NFKC").replace(/\s+/gu, " ").trim();
export function kstDay(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function parseHankyung(html: string, defaultCategory = ""): Report[] {
  if (/Block access|Access Denied|captcha|접근이 차단/i.test(html)) {
    throw new Error("SOURCE_BLOCKED: 수집 서버에서 원본 사이트 접근이 차단되었습니다.");
  }
  const $ = load(html);
  const table = $("table").filter((_i, t) => $(t).find("th").text().includes("작성일") && $(t).find("th").text().includes("제공출처")).first();
  const labels = table.find("th").map((_i, th) => compact($(th).text())).get();
  const index = (name: string) => labels.findIndex(s => s.startsWith(name));
  const dateIndex = index("작성일"), titleIndex = index("제목"), brokerIndex = index("제공출처");
  const authorIndex = index("작성자"), categoryIndex = index("분류");
  if (!table.length || [dateIndex, titleIndex, brokerIndex].some(i => i < 0)) throw new Error("SOURCE_LAYOUT: 리포트 목록 구조를 확인할 수 없습니다.");
  const records: Report[] = [];
  table.find("tr").each((_i, row) => {
    const cells = $(row).children("td");
    if (cells.length < 3) return;
    const published = compact(cells.eq(dateIndex).text());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(published)) {
      if (/\d{4}/.test(published)) throw new Error("SOURCE_LAYOUT: 작성일 형식이 변경되었습니다.");
      return;
    }
    const title = compact(cells.eq(titleIndex).find("a").first().text() || cells.eq(titleIndex).text());
    const link = $(row).find('a[href*="/analysis/downpdf"]').first().attr("href");
    const url = link ? new URL(link, "https://consensus.hankyung.com/") : undefined;
    if (!title || !url || url.protocol !== "https:" || url.hostname !== "consensus.hankyung.com") throw new Error("SOURCE_LAYOUT: 제목 또는 원문 링크가 누락되었습니다.");
    const chart = $(row).find('a[href*="report_type="]').first().attr("href");
    if (defaultCategory === "산업" && categoryIndex < 0 && chart && new URL(chart, url).searchParams.get("report_type") !== "IN") throw new Error("SOURCE_LAYOUT: 산업분석 목록이 아닙니다.");
    const sourceId = url.searchParams.get("report_idx");
    if (!sourceId || !/^\d+$/.test(sourceId)) throw new Error("SOURCE_LAYOUT: 리포트 ID가 누락되었습니다.");
    records.push({ sourceId, published, category: categoryIndex >= 0 ? compact(cells.eq(categoryIndex).text()) : defaultCategory,
      title, code: "", author: authorIndex >= 0 ? compact(cells.eq(authorIndex).text()) : "", broker: compact(cells.eq(brokerIndex).text()), url: url.href });
  });
  return records;
}


export class DeliveryError extends Error {
  definitive: boolean;
  constructor(message: string, definitive = false) { super(message); this.definitive = definitive; }
}
export const MAX_TELEGRAM_PDF_BYTES = 50_000_000;
export type TelegramDocument = { bytes: Uint8Array; filename: string; caption: string };

export async function sendTelegramDocument(document: TelegramDocument): Promise<string> {
  if (!document.bytes.length || document.bytes.length > MAX_TELEGRAM_PDF_BYTES ||
      Buffer.from(document.bytes.subarray(0, 5)).toString("ascii") !== "%PDF-") {
    throw new DeliveryError("PDF_ATTACHMENT: 전송 가능한 원문 PDF 파일이 필요합니다.", true);
  }
  if (document.caption.length > 1024) throw new DeliveryError("PDF_CAPTION: 설명이 너무 깁니다.", true);
  const form = new FormData();
  // Blob owns a copy; PDF contents are never re-encoded or rewritten.
  form.set("document", new Blob([new Uint8Array(document.bytes)], { type: "application/pdf" }), document.filename);
  form.set("caption", document.caption);
  return telegramRequest("sendDocument", form, 120000);
}

export async function sendTelegram(text: string): Promise<string> {
  return telegramRequest("sendMessage", { text, link_preview_options: { is_disabled: true } }, 20000);
}

async function telegramRequest(method: "sendMessage" | "sendDocument", payload: FormData | Record<string, unknown>, timeout: number): Promise<string> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new DeliveryError("텔레그램 연결정보가 없습니다.", true);
  const multipart = payload instanceof FormData;
  if (multipart) payload.set("chat_id", chatId);
  // 토큰이 URL에 포함되므로 fetch 원본 오류와 요청 URL은 출력하지 않습니다.
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", ...(multipart ? {} : { headers: { "Content-Type": "application/json" } }),
      body: multipart ? payload : JSON.stringify({ chat_id: chatId, ...payload }),
      signal: AbortSignal.timeout(timeout),
    });
    const body = await response.json() as { ok?: boolean; result?: { message_id: number }; error_code?: number };
    if (body.ok === false) throw new DeliveryError(`TELEGRAM_REJECTED: ${body.error_code || response.status}`, true);
    if (!response.ok || !body.result?.message_id) throw new DeliveryError("TELEGRAM_UNKNOWN_RESPONSE");
    return String(body.result.message_id);
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    throw new DeliveryError("TELEGRAM_UNCERTAIN: 네트워크 오류로 전송 결과를 확인할 수 없습니다.");
  }
}


export async function runConfiguredScan(live = false) {
  return (await import("./industry-bot.ts")).runIndustryScan(live);
}

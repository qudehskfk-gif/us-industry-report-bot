import { createHash } from "node:crypto";
import { load } from "cheerio";
import { compact, parseHankyung, MAX_TELEGRAM_PDF_BYTES } from "./report-bot.ts";
import type { Report } from "./report-bot.ts";
import { collectBrokerSource, resolveBrokerPdf } from "./broker-sources.ts";
import type { Source } from "./source-config.ts";
import { PUBLIC_CHANNELS, isChannelSource, collectPublicChannels, resolveChannelPdf, channelPublisherMatches } from "./public-channels.ts";
import { fetchPublicResource } from "./public-http.ts";

export type { Source } from "./source-config.ts";
export type IndustryReport = Report & {
  source: Source; sourceUrl: string; pdfUrl?: string; sector: string;
  excerpt?: string; coverText?: string; analysisText?: string; pdfHash?: string; pages?: number;
  // Transient original download bytes, excluded from database records and logs.
  pdfBytes?: Uint8Array;
};
export type SourceResult = { source: Source; reports: IndustryReport[]; truncated: boolean };
const API = "https://stock.naver.com/api/stockSecurity/researches/v2/industry";
const headers = { "User-Agent": "IndustryReportWatch/0.2 (personal research notifications)" };

export function parseNaverPage(payload: unknown): { reports: IndustryReport[]; hasNext: boolean } {
  const data = payload as { items?: unknown[]; hasNext?: boolean };
  if (!data || !Array.isArray(data.items) || typeof data.hasNext !== "boolean") {
    throw new Error("NAVER_LAYOUT: 산업 리포트 응답 형식이 변경되었습니다.");
  }
  if (data.hasNext && !data.items.length) throw new Error("NAVER_LAYOUT: 다음 페이지 표시와 목록 개수가 일치하지 않습니다.");
  const reports = data.items.map(value => {
    const r = value as Record<string, unknown>;
    if (!/^\d+$/.test(String(r.nid)) || typeof r.title !== "string" || !r.title.trim() ||
      typeof r.writeDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.writeDate) ||
      typeof r.brokerName !== "string" || !r.brokerName.trim()) {
      throw new Error("NAVER_LAYOUT: 리포트 ID·제목·발간일·증권사를 확인할 수 없습니다.");
    }
    const sourceUrl = `https://stock.naver.com/research/industry/${r.nid}`;
    const plain = load(String(r.content || "")).text();
    return {
      source: "naver" as const, sourceId: String(r.nid), sourceUrl, url: sourceUrl,
      title: compact(r.title), published: r.writeDate, broker: compact(r.brokerName),
      author: compact(String(r.analystName || "")), category: "산업", code: "",
      sector: compact(String(r.industryKoreanName || "미분류")), excerpt: compact(plain).slice(0, 5000),
    };
  });
  return { reports, hasNext: data.hasNext };
}

export async function collectSource(source: Source, options: {
  known?: Set<string>; maxPages?: number; fetcher?: typeof fetch;
} = {}): Promise<SourceResult> {
  if (isChannelSource(source)) return collectPublicChannels(source, options);
  if (source !== "hankyung" && source !== "naver") return collectBrokerSource(source, options);
  const fetcher = options.fetcher || fetch;
  const known = options.known || new Set<string>();
  const reports: IndustryReport[] = [];
  const pageSignatures = new Set<string>();
  const maxPages = options.maxPages || 10;
  for (let page = 0; page < maxPages; page++) {
    let rows: IndustryReport[];
    let hasNext = true;
    if (source === "naver") {
      const u = new URL(API); u.searchParams.set("index", String(page)); u.searchParams.set("size", "20");
      const response = await fetchPublicResource(u.href, { headers }, { fetcher, timeoutMs: 20000 });
      if (!response.ok) throw new Error(`NAVER_HTTP: ${response.status}`);
      const data = parseNaverPage(await response.json()); rows = data.reports; hasNext = data.hasNext;
    } else {
      const template = process.env.HANKYUNG_INDUSTRY_URL_TEMPLATE || "https://consensus.hankyung.com/analysis/list?skinType=industry&now_page={page}";
      const u = new URL(template.replace("{page}", String(page + 1)));
      if (u.protocol !== "https:" || u.hostname !== "consensus.hankyung.com") throw new Error("HANKYUNG_URL: 허용된 목록 주소가 아닙니다.");
      const response = await fetchPublicResource(u.href, { headers }, { fetcher, timeoutMs: 20000 });
      if (!response.ok) throw new Error(`HANKYUNG_HTTP: ${response.status}`);
      rows = parseHankyung(await response.text(), "산업").filter(r => r.category === "산업").map(r => ({
        ...r, source, sourceUrl: r.url, pdfUrl: r.url, sector: "미분류", code: "",
      }));
    }
    if (!rows.length) return { source, reports, truncated: false };
    const signature = rows.map(r => r.sourceId).join(",");
    if (pageSignatures.has(signature)) throw new Error(`${source.toUpperCase()}_PAGINATION: 같은 페이지가 반복됩니다.`);
    pageSignatures.add(signature); reports.push(...rows);
    if (!hasNext || rows.some(r => known.has(r.sourceId))) return { source, reports, truncated: false };
  }
  return { source, reports, truncated: true };
}

export async function resolvePdf(report: IndustryReport, fetcher: typeof fetch = fetch): Promise<IndustryReport> {
  if (isChannelSource(report.source)) {
    const resolved = await resolveChannelPdf(report, fetcher);
    return { ...resolved, pdfUrl: checkedPdfUrl(resolved.pdfUrl!) };
  }
  if (report.pdfUrl) return { ...report, pdfUrl: checkedPdfUrl(report.pdfUrl) };
  if (report.source !== "naver") {
    const resolved = await resolveBrokerPdf(report, fetcher);
    return resolved.pdfUrl ? { ...resolved, pdfUrl: checkedPdfUrl(resolved.pdfUrl) } : resolved;
  }
  const response = await fetchPublicResource(`${API}/${report.sourceId}`, { headers }, { fetcher, timeoutMs: 20000 });
  if (!response.ok) throw new Error(`NAVER_DETAIL_HTTP: ${response.status}`);
  const data = await response.json() as { nid?: string; attachUrl?: string; title?: string };
  if (String(data.nid) !== report.sourceId) throw new Error("NAVER_DETAIL_LAYOUT: 요청한 리포트와 ID가 다릅니다.");
  return { ...report, pdfUrl: data.attachUrl ? checkedPdfUrl(data.attachUrl) : undefined };
}

export function checkedPdfUrl(value: string): string {
  const u = new URL(value);
  const allowed = ["consensus.hankyung.com", "www.hankyung.com", "stock.pstatic.net", "upload.stock.naver.com",
    "www.hanaw.com", "file.hanaw.com", "securities.miraeasset.com", "home-files.tossinvest.com",
    "m.iprovest.com", "www.iprovest.com", "www.myasset.com", "file.myasset.com",
    "www.sangsanginib.com", "www.hmsec.com", "www.hygood.co.kr",
    ...Object.values(PUBLIC_CHANNELS).flatMap(config => [...config.hosts])];
  if (u.protocol !== "https:" || u.username || u.password || u.port || !allowed.includes(u.hostname)) throw new Error("PDF_URL: 허용된 원문 호스트가 아닙니다.");
  return u.href;
}

export async function inspectPdf(report: IndustryReport, fetcher: typeof fetch = fetch): Promise<IndustryReport> {
  const r = await resolvePdf(report, fetcher);
  if (!r.pdfUrl) throw new Error("PDF_MISSING: 원문 PDF 링크가 없습니다.");
  let next = checkedPdfUrl(r.pdfUrl);
  let response: Response | undefined;
  // Validate every redirect target; do not send cookies or credentials to report hosts.
  for (let i = 0; i < 5; i++) {
    response = await fetchPublicResource(next, { headers, redirect: "manual" }, { fetcher, timeoutMs: 90000 });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location"); if (!location) throw new Error("PDF_REDIRECT");
      await response.body?.cancel(); next = checkedPdfUrl(new URL(location, next).href); continue;
    }
    break;
  }
  if (!response?.ok || !response.body) throw new Error(`PDF_HTTP: ${response?.status}`);
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length; if (size > MAX_TELEGRAM_PDF_BYTES) throw new Error("PDF_SIZE: 텔레그램 파일 한도 50 MB를 초과했습니다.");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("PDF_FORMAT: PDF 원문이 아닙니다.");
  const pdfBytes = new Uint8Array(bytes);
  const pdfHash = createHash("sha256").update(pdfBytes).digest("hex");
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(bytes), verbosity: 0 });
  try {
    const info = await parser.getInfo();
    const partial = Array.from({ length: Math.min(info.total, 200) }, (_v, i) => i + 1);
    const text = await parser.getText({ partial });
    const coverText = text.pages.filter(page => page.num <= 3).map(page => page.text).join("\n").slice(0, 16000);
    const analysisText = text.pages.map(page => page.text).join("\n\f\n").slice(0, 400000);
    // Publisher logos can be images on the cover. The final compliance pages
    // often contain the text identity; still require the matching official host.
    if (isChannelSource(r.source) && !channelPublisherMatches(r.source, analysisText)) throw new Error("CHANNEL_ISSUER: PDF 본문에서 해당 증권사 발행을 확인하지 못했습니다.");
    const channelCompany = isChannelSource(r.source) && /기업\s*분석(?!부|팀)|\bcompany\s*(?:report|update|initiation)\b/iu.test(coverText.slice(0, 1400)) && !/산업\s*분석|\bindustry\b|\bsector\b/iu.test(coverText.slice(0, 1400));
    return { ...r, ...(channelCompany ? { category: "기업" } : {}), pages: info.total, coverText, analysisText, pdfHash, pdfBytes };
  } finally { await parser.destroy(); }
}

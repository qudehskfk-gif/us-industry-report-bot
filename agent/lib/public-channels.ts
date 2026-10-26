import { createHash } from "node:crypto";
import { load } from "cheerio";
import { compact, kstDay } from "./report-bot.ts";
import { fetchPublicResource } from "./public-http.ts";
import type { IndustryReport, SourceResult } from "./industry-sources.ts";

// The feed is public Telegram HTML. PDF bytes must come from the named
// publisher's public HTTPS servers; attached Telegram-only files are not used.
export const PUBLIC_CHANNELS = {
  kiwoom: { broker: "키움증권", channels: ["KiwoomResearch"], hosts: ["bbn.kiwoom.com", "invest.kiwoom.com", "www1.kiwoom.com"] },
  meritz: { broker: "메리츠증권", channels: ["meritz_research"], hosts: ["home.imeritz.com", "www.imeritz.com"] },
  korea: { broker: "한국투자증권", channels: ["KISemicon", "enc210406"], hosts: ["file.truefriend.com", "www.truefriend.com", "research.truefriend.com", "securities.koreainvestment.com", "research.koreainvestment.com"] },
  samsung: { broker: "삼성증권", channels: ["jw_tech"], hosts: ["www.samsungpop.com", "english.samsungpop.com"] },
  sk: { broker: "SK증권", channels: ["sksresearch", "skitteam"], hosts: ["www.sks.co.kr", "sks.co.kr", "research.sks.co.kr"] },
  nh: { broker: "NH투자증권", channels: ["nhis_bio"], hosts: ["m.nhsec.com", "m.nhqv.com", "download.nhqv.com", "www.nhsec.com"] },
  shinhan: { broker: "신한투자증권", channels: ["shinhanresearch"], hosts: ["bbs2.shinhansec.com", "bbs2.shinhaninvest.com", "file.shinhansec.com"] },
} as const;
export type ChannelSource = keyof typeof PUBLIC_CHANNELS;
const shorteners = new Set(["bit.ly", "buly.kr", "han.gl", "vo.la", "tinyurl.com", "zrr.kr", "naver.me"]);
export function isChannelSource(source: string): source is ChannelSource { return Object.hasOwn(PUBLIC_CHANNELS, source); }

function publicLink(value: string, source: ChannelSource): URL {
  const u = new URL(value);
  // Published HTTP links can be tried over HTTPS, but insecure downloads and
  // redirects are never followed.
  if (u.protocol === "http:") u.protocol = "https:";
  if (u.protocol !== "https:" || u.username || u.password || u.port ||
    !shorteners.has(u.hostname) && !(PUBLIC_CHANNELS[source].hosts as readonly string[]).includes(u.hostname)) {
    throw new Error("CHANNEL_URL: 허용된 공개 배포 주소가 아닙니다.");
  }
  return u;
}

function postTitle(text: string): string {
  const lines = text.split(/\n/u).map(compact).filter(Boolean);
  const useful = lines.map(line => line.replace(/^[\p{Extended_Pictographic}\uFE0F\s]+/u, "").replace(/^\[(?:키움|메리츠|한투|삼성|SK|NH|한국투자|신한)[^\]]*\]\s*/iu, ""))
    .filter(line => line && !/^(?:Analyst\b|안녕|텔레그램|https?:\/\/|감사합니다|자료\s*(?:링크)?\s*[:：])/iu.test(line) && !/^\d{4}[./-]\s*\d{1,2}[./-]\s*\d{1,2}\s*(?:\([^)]*\))?$/u.test(line));
  return (useful[0] || lines[0] || "공개 리포트").replace(/^[▶️■★☆🌏\s]+/u, "").slice(0, 250);
}

export function channelPublisherMatches(source: ChannelSource, text: string): boolean {
  const names: Record<ChannelSource, RegExp> = {
    kiwoom: /키움증권|kiwoom/iu, meritz: /메리츠|meritz/iu,
    korea: /한국투자증권|korea\s*investment|kis\s*(?:research|securities)/iu,
    samsung: /삼성증권|samsung\s*(?:securities|research)/iu,
    sk: /SK\s*증권|SK\s*(?:securities|research)/iu,
    nh: /NH\s*투자증권|NH\s*(?:investment|securities|research)/iu,
    shinhan: /신한\s*(?:투자증권|금융투자)|shinhan/iu,
  };
  return names[source].test(text);
}

function category(title: string, text: string): string {
  if (/\b(?:review|earnings|preview)\b|실적\s*(?:리뷰|프리뷰)|목표(?:주가|가)|\bTP\s*[:：]?\s*[\d,]+|\(\s*Not\s*Rated\s*\)|\([A-Z]?\d{6}(?:\.(?:KS|KQ))?\)/iu.test(title) ||
    /\([A-Z.]{1,8}(?:[ .]US)?\)/u.test(title)) return "기업";
  const scope = /산업|업종|섹터|밸류체인|인[\s·-]*뎁스|\bin[ -]*depth\b|심층|반도체|광통신|소재장비|전력|원전|원자력|에너지|태양광|헬스케어|제약|바이오|로봇|우주|항공|데이터센터|소프트웨어|인터넷|통신|건설|조선|자동차|배터리|의료기기/iu;
  return scope.test(title) || /산업|업종|인[\s·-]*뎁스|\bin[ -]*depth\b|심층/iu.test(text.slice(0, 700)) ? "산업" : "기타";
}

export function channelPdfCategory(source: ChannelSource, pdfUrl: string, current: string, coverText: string): string {
  // Kiwoom publishes Company Reports under rfCR, separately from rfCI industry
  // reports. A sector word in a company title must not turn it into an industry.
  if (source === "kiwoom" && /\/rfCR\d+(?:\.pdf)?(?:$|\?)/u.test(pdfUrl)) return "기업";
  // Check the opening document type, not a later table-of-contents entry for
  // the company appendix included in an industry study.
  const opening = coverText.slice(0, 300);
  const company = /기업\s*분석(?!부|팀)|\bcompany\s*(?:report|update|initiation)\b/iu.test(opening);
  return company && !/산업\s*분석|\bindustry\b|\bsector\b/iu.test(opening) ? "기업" : current;
}

export function parsePublicChannel(html: string, source: ChannelSource, channel: string): {
  reports: IndustryReport[]; previous?: string; posts: number;
} {
  const config = PUBLIC_CHANNELS[source];
  if (!(config.channels as readonly string[]).includes(channel)) throw new Error("CHANNEL_CONFIG: 확인되지 않은 공개 채널입니다.");
  const $ = load(html), nodes = $(".tgme_widget_message[data-post]");
  if (!nodes.length) throw new Error("CHANNEL_LAYOUT: 공개 게시물이 없거나 접속 제한 화면입니다.");
  const reports: IndustryReport[] = [];
  const seen = new Set<string>();
  for (const node of nodes.toArray()) {
    const row = $(node), id = row.attr("data-post") || "";
    const match = id.match(/^([a-zA-Z0-9_]+)\/(\d+)$/u);
    if (!match || match[1].toLowerCase() !== channel.toLowerCase()) throw new Error("CHANNEL_LAYOUT: 요청한 채널과 게시물 ID가 다릅니다.");
    const rawTime = row.find("time[datetime]").first().attr("datetime");
    if (!rawTime || !Number.isFinite(Date.parse(rawTime))) throw new Error("CHANNEL_LAYOUT: 게시 시각을 확인할 수 없습니다.");
    const body = row.find(".tgme_widget_message_text").clone();
    body.find("br").replaceWith("\n");
    const text = body.text().trim();
    if (!text) continue;
    const title = postTitle(text);
    const links = body.find("a[href]").map((index, anchor) => {
      const href = $(anchor).attr("href") || "";
      try {
        const u = publicLink(href, source);
        if (shorteners.has(u.hostname)) {
          const marked = body.clone(); marked.find("a[href]").eq(index).replaceWith("CHANNEL_REPORT_LINK_MARKER");
          const before = marked.text().split("CHANNEL_REPORT_LINK_MARKER")[0].split(/\n/u).slice(-2).join(" ");
          if (!/보고서|리포트|자료|원문|\breport\b|download/iu.test(before + " " + $(anchor).text())) return "";
        }
        return href;
      } catch { return ""; }
    }).get().filter(Boolean);
    for (const link of links) {
      let u: URL; try { u = publicLink(link, source); } catch { continue; }
      if (!shorteners.has(u.hostname) && !/\.pdf(?:$|\?)|\/rf[A-Za-z0-9]+$|pdf|download|fileView|\/c\/[a-z0-9]+/iu.test(u.href)) continue;
      if (seen.has(`${id}|${u.href}`)) continue; seen.add(`${id}|${u.href}`);
      const hash = createHash("sha256").update(u.href).digest("hex").slice(0, 16);
      const sourceUrl = `https://t.me/${channel}/${match[2]}`;
      reports.push({ source, sourceId: `${channel}/${match[2]}/${hash}`, sourceUrl, url: sourceUrl,
        published: kstDay(new Date(rawTime)), broker: config.broker, author: "", code: "",
        title, category: channelPdfCategory(source, u.href, category(title, text), ""), sector: "공개 산업 리포트", excerpt: text.slice(0, 12000), pdfUrl: u.href,
      });
    }
  }
  const href = $("a.tme_messages_more[href]").first().attr("href");
  let previous: string | undefined;
  if (href) {
    const u = new URL(href, `https://t.me/s/${channel}`), before = u.searchParams.get("before");
    if (u.protocol !== "https:" || u.hostname !== "t.me" || u.pathname.toLowerCase() !== `/s/${channel}`.toLowerCase() || !before || !/^\d+$/u.test(before)) {
      throw new Error("CHANNEL_PAGINATION: 허용되지 않은 이전 페이지 주소입니다.");
    }
    previous = u.href;
  }
  return { reports, previous, posts: nodes.length };
}

async function channelHtml(address: string, fetcher: typeof fetch): Promise<string> {
  const response = await fetchPublicResource(address, { redirect: "manual", headers: { "User-Agent": "IndustryReportWatch/0.7 (personal research notifications)" } }, { fetcher });
  if (!response.ok || !response.body) throw new Error(`CHANNEL_HTTP: ${response.status}`);
  let size = 0; const chunks: Uint8Array[] = [];
  for await (const part of response.body) { size += part.length; if (size > 5_000_000) throw new Error("CHANNEL_SIZE"); chunks.push(part); }
  return Buffer.concat(chunks).toString("utf8");
}

export async function collectPublicChannels(source: ChannelSource, options: {
  known?: Set<string>; maxPages?: number; fetcher?: typeof fetch;
} = {}): Promise<SourceResult> {
  const fetcher = options.fetcher || fetch, reports: IndustryReport[] = [], known = options.known || new Set<string>();
  let truncated = false;
  for (const channel of PUBLIC_CHANNELS[source].channels) {
    let address: string | undefined = `https://t.me/s/${channel}`;
    const visited = new Set<string>();
    for (let page = 0; address && page < (options.maxPages || 10); page++) {
      if (visited.has(address)) throw new Error("CHANNEL_PAGINATION: 같은 페이지가 반복됩니다.");
      visited.add(address);
      const parsed = parsePublicChannel(await channelHtml(address, fetcher), source, channel);
      reports.push(...parsed.reports);
      if (parsed.reports.some(r => known.has(r.sourceId))) { address = undefined; break; }
      address = parsed.previous;
    }
    if (address) truncated = true;
  }
  return { source, reports, truncated };
}

export async function resolveChannelPdf(report: IndustryReport, fetcher: typeof fetch): Promise<IndustryReport> {
  if (!isChannelSource(report.source) || !report.pdfUrl) throw new Error("CHANNEL_PDF: 원문 링크가 없습니다.");
  let u = publicLink(report.pdfUrl, report.source);
  for (let step = 0; step < 8; step++) {
    const response = await fetchPublicResource(u.href, { redirect: "manual" }, { fetcher });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location"); await response.body?.cancel();
      if (!location) throw new Error("CHANNEL_REDIRECT");
      const target = new URL(location, u);
      // A published plain-HTTP target is requested only at its HTTPS version.
      // No insecure request is made, and the publisher/shortener allowlist applies.
      u = publicLink(target.href, report.source); continue;
    }
    if (!response.ok || !response.body) throw new Error(`CHANNEL_PDF_HTTP: ${response.status}`);
    const isPublisher = (PUBLIC_CHANNELS[report.source].hosts as readonly string[]).includes(u.hostname);
    const type = response.headers.get("content-type") || "";
    if (isPublisher && /pdf|octet-stream/iu.test(type)) { await response.body.cancel(); return { ...report, pdfUrl: u.href }; }
    // Some public link services return a small HTML page with the public PDF.
    const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length;
      if (size > 1_000_000) throw new Error("CHANNEL_LINK_SIZE"); chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => {}); }
    const bytes = Buffer.concat(chunks);
    if (isPublisher && bytes.subarray(0, 5).toString() === "%PDF-") return { ...report, pdfUrl: u.href };
    const html = bytes.toString("utf8"), $ = load(html);
    if (/captcha|verify you are human|로그인\s*후|회원\s*전용|접근\s*권한/iu.test($("body").text())) throw new Error("CHANNEL_ACCESS: 공개 원문을 확인할 수 없습니다.");
    let target: string | undefined;
    const refresh = $("meta[http-equiv]").filter((_, e) => ($(e).attr("http-equiv") || "").toLowerCase() === "refresh").first().attr("content")?.match(/url\s*=\s*['"]?([^'";]+)['"]?/iu)?.[1];
    if (refresh) target = refresh;
    if (!target) target = $("a[href],iframe[src],embed[src]").map((_, e) => $(e).attr("href") || $(e).attr("src") || "").get().find(value => {
      try { const link = new URL(value, u); return (PUBLIC_CHANNELS[report.source as ChannelSource].hosts as readonly string[]).includes(link.hostname) && /pdf|download|fileView/iu.test(link.href); } catch { return false; }
    });
    if (!target) throw new Error("CHANNEL_PDF_MISSING: 게시물만 있고 공개 PDF 원문 링크가 없습니다.");
    const next = new URL(target, u);
    u = publicLink(next.href, report.source);
  }
  throw new Error("CHANNEL_REDIRECT: 이동 횟수가 너무 많습니다.");
}

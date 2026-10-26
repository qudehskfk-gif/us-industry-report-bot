import { load } from "cheerio";
import { compact } from "./report-bot.ts";
import { SOURCE_NAMES } from "./source-config.ts";
import type { Source } from "./source-config.ts";
import type { IndustryReport, SourceResult } from "./industry-sources.ts";
import { fetchPublicResource } from "./public-http.ts";

export type BrokerSource = Extract<Source, "hana" | "mirae" | "toss" | "kyobo" | "yuanta" | "sangsang" | "hyundai" | "hanyang">;
type Page = { reports: IndustryReport[]; hasNext: boolean; nextUrl?: string };
const urls: Record<BrokerSource, string> = {
  hana: "https://www.hanaw.com/main/research/research/list.cmd?pid=8&cid=2",
  mirae: "https://securities.miraeasset.com/bbs/board/message/list.do?categoryId=1525",
  toss: "https://docs-api.tossinvest.com/api/v1/post/search?categoryId=138&searchTitleKeyword=&size=10&type=INVESTMENT_INFO",
  kyobo: "https://m.iprovest.com/weblogic/ResearchServlet/newReports",
  yuanta: "https://www.myasset.com/myasset/research/rs_list/rs_list.cmd?cd006=&cd007=RE02&cd008=&m_menuId=ind",
  sangsang: "https://www.sangsanginib.com/notice/getNoticeList",
  hyundai: "https://www.hmsec.com/research/research_list_ajax.do?Menu_category=2",
  hanyang: "https://www.hygood.co.kr/board/researchAnalyzeIssue/list",
};
const publicPages: Partial<Record<BrokerSource, string>> = {
  toss: "https://corp.tossinvest.com/ko/investment-info?tab=research-insight",
  sangsang: "https://www.sangsanginib.com/research/industryReport/industryReportView",
  hyundai: "https://www.hmsec.com/mobile/research/research01_list.do?Menu_category=2",
};
const headers = { "User-Agent": "IndustryReportWatch/0.6 (personal research notifications)" };
const fail = (source: string, reason: string): never => { throw new Error(`${source.toUpperCase()}_LAYOUT: ${reason}`); };
const plain = (value: unknown) => compact(load(String(value ?? "")).text());
const digits = (v: unknown) => /^\d+$/u.test(String(v ?? ""));
function date(value: unknown, source: string): string {
  const match = String(value).match(/(\d{4})[-./](\d{2})[-./](\d{2})/u);
  if (!match) return fail(source, "발간일을 확인할 수 없습니다.");
  const day = `${match[1]}-${match[2]}-${match[3]}`;
  if (!Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) return fail(source, "발간일이 올바르지 않습니다.");
  return day;
}
function pdfLink(value: string, base: string): string {
  const u = new URL(value, base);
  if (u.protocol !== "https:" || u.username || u.password || u.port) throw new Error("PDF_URL: 올바른 공개 원문 주소가 아닙니다.");
  return u.href;
}
function report(source: BrokerSource, id: string, title: string, published: unknown, extra: Partial<IndustryReport> = {}): IndustryReport {
  if (!id || !title.trim()) return fail(source, "리포트 ID 또는 제목이 누락됐습니다.");
  const sourceUrl = publicPages[source] || urls[source];
  return { source, sourceId: id, sourceUrl, url: sourceUrl, title: compact(title), published: date(published, source),
    broker: SOURCE_NAMES[source], author: "", category: "산업", sector: "미분류", code: "", ...extra };
}
function count(html: string, source: string): number {
  const found = html.match(/["']?totalNum["']?\s*:\s*["']?([\d,]+)/u);
  if (!found) return fail(source, "목록 전체 건수 표시가 변경됐습니다.");
  return Number(found[1].replaceAll(",", ""));
}
function checkedListUrl(value: string, base: string): string {
  const u = new URL(value, base), expected = new URL(base);
  if (u.protocol !== "https:" || u.origin !== expected.origin || u.pathname !== expected.pathname) throw new Error("SOURCE_URL: 허용된 목록 주소가 아닙니다.");
  return u.href;
}

export function parseHana(html: string, page = 1): Page {
  const $ = load(html), nodes = $(".daily_bbs > ul > li");
  if (!$(".daily_bbs").length) return fail("hana", "산업 목록이 없거나 로그인·접속 제한 화면입니다.");
  const total = count(html, "hana");
  const reports = nodes.map((_, el) => {
    const row = $(el), a = row.find(".con h3 a").first();
    const id = a.attr("id")?.match(/^4002_(\d+)$/u)?.[1];
    if (!id) return fail("hana", "산업 게시물 ID를 확인할 수 없습니다.");
    const attachment = row.find("a.j_fileLink").filter((_, x) => /\.pdf$/iu.test($(x).text().trim())).first();
    const href = attachment.attr("href");
    return report("hana", id, a.text(), row.find(".info .txtbasic").first().text(), {
      sector: "글로벌 산업", author: compact(row.find(".view-txt").text()), excerpt: compact(row.find(".j_bbsContn").text()).slice(0, 5000),
      ...(href ? { pdfUrl: pdfLink(href, urls.hana) } : {}),
    });
  }).get();
  if (!reports.length && total) return fail("hana", "등록 건수와 목록이 일치하지 않습니다.");
  return { reports, hasNext: total > page * 10 };
}

export function parseMirae(html: string, page = 1, current = urls.mirae): Page {
  const $ = load(html), anchors = $(".subject a[id^=bbsTitle]");
  if (!anchors.length) return fail("mirae", "산업 목록이 없거나 접속 제한 화면입니다.");
  const reports = anchors.map((_, el) => {
    const a = $(el), row = a.closest("tr"), id = a.attr("href")?.match(/view\(['"](\d+)['"]/u)?.[1];
    if (!id) return fail("mirae", "게시물 ID가 변경됐습니다.");
    const attachment = row.find("a[href*='downConfirm']").attr("href")?.match(/downConfirm\(['"]([^'"]+)['"]/u)?.[1];
    const title = a.clone(); title.find("br").replaceWith(" ");
    return report("mirae", id, title.text(), row.find("td").first().text(), {
      sourceUrl: current, url: current, author: compact(row.find("td").last().text()), sector: compact(a.find("b").text()),
      ...(attachment ? { pdfUrl: pdfLink(attachment, urls.mirae) } : {}),
    });
  }).get();
  const next = $("a[href]").map((_, e) => $(e).attr("href")!).get().find(href => {
    try { const u = new URL(href, current); return u.searchParams.get("categoryId") === "1525" && u.searchParams.get("curPage") === String(page + 1); } catch { return false; }
  });
  return { reports, hasNext: !!next, ...(next ? { nextUrl: checkedListUrl(next, current) } : {}) };
}

export function parseYuanta(html: string, page = 1): Page {
  const $ = load(html), anchors = $("a[cmd-type=view][data-seq]");
  if (!/cd007\s*:\s*["']RE02["']/u.test(html)) return fail("yuanta", "산업분석(RE02) 목록이 아닙니다.");
  const total = count(html, "yuanta");
  const reports = anchors.map((_, el) => {
    const a = $(el), row = a.closest("tr"), id = a.attr("data-seq");
    if (!digits(id)) return fail("yuanta", "게시물 ID가 누락됐습니다.");
    const title = a.clone(); title.find("p").remove();
    const file = row.find("a[cmd-type=download]").attr("data-seq");
    const sourceUrl = `https://www.myasset.com/myasset/research/rs_list/rs_view.cmd?cd007=RE02&SEQ=${id}`;
    return report("yuanta", id!, title.text(), row.find("td").first().text(), {
      sourceUrl, url: sourceUrl, author: compact(row.find("a.js-link").text()), excerpt: compact(a.find("p").text()),
      ...(file ? { pdfUrl: `https://www.myasset.com/myasset/common/commonFile/downloadFromFileServer.cmd?ATTACH_FILE=${encodeURIComponent(file)}` } : {}),
    });
  }).get();
  if (!reports.length && total) return fail("yuanta", "등록 건수와 목록이 일치하지 않습니다.");
  return { reports, hasNext: total > page * 10 };
}

export function parseKyobo(html: string, page = 1, current = urls.kyobo): Page {
  const $ = load(html), nodes = $(".re_division");
  if (!nodes.length) return fail("kyobo", "리포트 목록이 없거나 요청 차단 화면입니다.");
  const reports = nodes.map((_, el) => {
    const category = compact($(el).text()), row = $(el).closest("li");
    const href = row.find("a[href*='RSDownloadServlet']").attr("href");
    if (!href) return fail("kyobo", "원문 첨부 주소가 누락됐습니다.");
    const pdfUrl = pdfLink(href, urls.kyobo), file = new URL(pdfUrl).searchParams.get("filePath");
    if (!file || !/\.pdf$/iu.test(file)) return fail("kyobo", "PDF 파일 경로를 확인할 수 없습니다.");
    const meta = row.find(".re_list_txt");
    return report("kyobo", file, row.find("h4").first().text(), meta.eq(0).text(), {
      category: category === "산업분석" ? "산업" : category, sector: compact(meta.eq(1).text()), author: compact(meta.eq(2).text()), pdfUrl,
      sourceUrl: current, url: current,
    });
  }).get();
  const next = $("a[href]").map((_, e) => $(e).attr("href")!).get().find(href => {
    try { return new URL(href, current).searchParams.get("pageNum") === String(page + 1); } catch { return false; }
  });
  return { reports, hasNext: !!next, ...(next ? { nextUrl: checkedListUrl(next, current) } : {}) };
}

export function parseHanyang(html: string, page = 1): Page {
  const $ = load(html), anchors = $("a[href*='/researchAnalyzeIssue/detail/']");
  if (!/산업 및 이슈분석/u.test($("body").text())) return fail("hanyang", "산업 및 이슈분석 화면이 아닙니다.");
  const total = Number($("body").text().match(/총\s*([\d,]+)\s*건/u)?.[1].replaceAll(",", ""));
  if (!Number.isFinite(total)) return fail("hanyang", "등록 건수를 확인할 수 없습니다.");
  const reports = anchors.map((_, el) => {
    const a = $(el), row = a.closest("tr"), href = a.attr("href")!;
    const id = href.match(/\/detail\/(\d+)/u)?.[1];
    if (!id) return fail("hanyang", "게시물 ID가 누락됐습니다.");
    const sourceUrl = new URL(href.replace(/;jsessionid=[^/?]+/iu, ""), urls.hanyang).href;
    const attachment = row.find("a[href*='/download?']").attr("href");
    return report("hanyang", id, a.text(), row.find("td").eq(2).text(), {
      sourceUrl, url: sourceUrl, ...(attachment ? { pdfUrl: pdfLink(attachment, urls.hanyang) } : {}),
    });
  }).get();
  if (!reports.length && total) return fail("hanyang", "등록 건수와 목록이 일치하지 않습니다.");
  return { reports, hasNext: total > page * 10 };
}

function object(value: unknown, source: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(source, "목록 응답 형식이 변경됐습니다.");
  return value as Record<string, any>;
}
export function parseToss(payload: unknown, page = 1): Page {
  const envelope = object(payload, "toss"), data = object(envelope.result, "toss");
  if (!Array.isArray(data.list) || !Number.isInteger(data.pagingParam?.totalPageCount) || data.pagingParam.page !== page - 1) return fail("toss", "페이지 번호 또는 목록 구조가 변경됐습니다.");
  const reports = data.list.map((value: unknown) => {
    const r = object(value, "toss");
    if (!digits(r.id) || r.category?.id !== 138 || typeof r.title !== "string" || !Array.isArray(r.files)) return fail("toss", "인사이트 게시물 구조가 변경됐습니다.");
    const excerpt = plain(r.contents).slice(0, 12000);
    const industry = /(?:산업|업종).{0,12}(?:전반|구조|생태계|경쟁|수요|공급|방향|변화|분석|전망)|밸류\s*체인|\bvalue\s+chain\b|GTC\s+DEEP\s+DIVE/iu.test(`${r.title} ${excerpt}`);
    const pdf = r.files.find((f: any) => typeof f.filePath === "string" && /\.pdf(?:$|\?)/iu.test(f.filePath));
    const sourceUrl = `https://corp.tossinvest.com/ko/post?category=138&id=${r.id}&type=research-insight`;
    return report("toss", String(r.id), r.title, r.displayDt, {
      sourceUrl, url: sourceUrl, category: industry ? "산업" : "기타", sector: industry ? "글로벌 산업" : "미분류", excerpt,
      author: excerpt.match(/작성자\s*:\s*([^\n]{1,70}?)\s*(?:애널리스트|최근|지난)/u)?.[1] || "토스증권 리서치센터",
      ...(pdf ? { pdfUrl: pdfLink(pdf.filePath, urls.toss) } : {}),
    });
  });
  if (!reports.length && data.pagingParam.totalPageCount > page) return fail("toss", "빈 목록에 다음 페이지가 표시됐습니다.");
  return { reports, hasNext: data.pagingParam.totalPageCount > page };
}
export function parseSangsang(payload: unknown, page = 1): Page {
  if (!Array.isArray(payload) || !payload.length) return fail("sangsang", "목록 응답 형식이 변경됐습니다.");
  const data = object(payload[0], "sangsang");
  if (!Array.isArray(data.getNoticeList) || !Number.isInteger(data.getCount)) return fail("sangsang", "목록·전체 건수가 누락됐습니다.");
  const reports = data.getNoticeList.map((value: unknown) => {
    const r = object(value, "sangsang");
    if (!digits(r.NT_NO) || typeof r.TITLE !== "string") return fail("sangsang", "게시물 ID 또는 제목이 누락됐습니다.");
    return report("sangsang", String(r.NT_NO), r.TITLE, r.REGDT, { sector: String(r.STOCK_NM || "미분류") });
  });
  if (!reports.length && data.getCount > (page - 1) * 10) return fail("sangsang", "등록 건수와 목록이 일치하지 않습니다.");
  return { reports, hasNext: data.getCount > page * 10 };
}
export function parseHyundai(payload: unknown, page = 1): Page {
  const data = object(payload, "hyundai");
  if (!Array.isArray(data.data_list) || data.curPage !== page || !Number.isInteger(data.paging?.totalPages)) return fail("hyundai", "목록·페이지 구조가 변경됐습니다.");
  const reports = data.data_list.map((value: unknown) => {
    const r = object(value, "hyundai");
    if (!digits(r.SERIAL_NO) || typeof r.SUBJECT !== "string" || !digits(r.REG_DATE)) return fail("hyundai", "게시물 구조가 변경됐습니다.");
    if (String(r.REG_DATE).length !== 8) return fail("hyundai", "발간일이 변경됐습니다.");
    const d = String(r.REG_DATE), name = String(r.UPLOAD_FILE1 || "");
    if (name && !/^[\w.-]+\.pdf$/iu.test(name)) return fail("hyundai", "PDF 파일명이 올바르지 않습니다.");
    return report("hyundai", String(r.SERIAL_NO), r.SUBJECT, `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`, {
      category: r.MENU_CODE === 202 && r.MENU_SUBJECT === "Industry Report" ? "산업" : "기타", author: String(r.NAME || ""), excerpt: plain(r.CONTENTS).slice(0, 5000),
      ...(name ? { pdfUrl: `https://www.hmsec.com/documents/research/${name}` } : {}),
    });
  });
  if (!reports.length && data.paging.totalPages > page) return fail("hyundai", "빈 목록에 다음 페이지가 표시됐습니다.");
  return { reports, hasNext: data.paging.totalPages > page };
}

async function read(source: BrokerSource, address: string, fetcher: typeof fetch, init: RequestInit = {}): Promise<string> {
  const expected = new URL(urls[source]);
  let next = address;
  for (let redirect = 0; redirect < 5; redirect++) {
    const u = new URL(next);
    if (u.protocol !== "https:" || u.origin !== expected.origin || u.username || u.password) throw new Error("SOURCE_URL: 허용된 출처가 아닙니다.");
    const response = await fetchPublicResource(u.href, { ...init, headers: { ...headers, ...init.headers }, redirect: "manual" }, { fetcher, retrySafe: true });
    if (response.status >= 300 && response.status < 400) {
      const target = response.headers.get("location"); if (!target) throw new Error("SOURCE_REDIRECT");
      await response.body?.cancel(); next = new URL(target, next).href; continue;
    }
    if (!response.ok || !response.body) throw new Error(`${source.toUpperCase()}_HTTP: ${response.status}`);
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const part of response.body) { size += part.length; if (size > 5_000_000) throw new Error("SOURCE_SIZE: 목록 응답이 너무 큽니다."); chunks.push(part); }
    const bytes = Buffer.concat(chunks);
    const encoding = response.headers.get("content-type")?.match(/charset=([\w-]+)/iu)?.[1] || (source === "mirae" ? "euc-kr" : "utf-8");
    return new TextDecoder(encoding).decode(bytes);
  }
  throw new Error("SOURCE_REDIRECT: 이동 횟수가 너무 많습니다.");
}
const post = (params: Record<string, string>): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: new URLSearchParams(params).toString() });

export async function collectBrokerSource(source: BrokerSource, options: { known?: Set<string>; maxPages?: number; fetcher?: typeof fetch } = {}): Promise<SourceResult> {
  const fetcher = options.fetcher || fetch, known = options.known || new Set<string>();
  const reports: IndustryReport[] = [], signatures = new Set<string>();
  let current = urls[source];
  for (let page = 1; page <= (options.maxPages || 10); page++) {
    const u = new URL(current); let init: RequestInit = {};
    if (source === "hana") u.searchParams.set("curPage", String(page));
    if (source === "toss") u.searchParams.set("page", String(page - 1));
    if (source === "yuanta") u.searchParams.set("page", String(page));
    if (source === "hanyang") u.searchParams.set("pageIndex", String(page));
    if (source === "sangsang") init = post({ cmsCd: "CM0338", rowNum: "10", startRow: String((page - 1) * 10), pageNum: String(page), src: "all", sdt: "", edt: "" });
    if (source === "hyundai") init = post({ curPage: String(page) });
    const text = await read(source, u.href, fetcher, init);
    let parsed: Page;
    if (source === "hana") parsed = parseHana(text, page);
    else if (source === "mirae") parsed = parseMirae(text, page, current);
    else if (source === "yuanta") parsed = parseYuanta(text, page);
    else if (source === "kyobo") parsed = parseKyobo(text, page, current);
    else if (source === "hanyang") parsed = parseHanyang(text, page);
    else {
      let data: unknown; try { data = JSON.parse(text); } catch { return fail(source, "JSON 대신 로그인·오류 화면이 반환됐습니다."); }
      parsed = source === "toss" ? parseToss(data, page) : source === "sangsang" ? parseSangsang(data, page) : parseHyundai(data, page);
    }
    const signature = parsed.reports.map(r => r.sourceId).join(",");
    if (signature && signatures.has(signature)) throw new Error(`${source.toUpperCase()}_PAGINATION: 같은 페이지가 반복됩니다.`);
    signatures.add(signature); reports.push(...parsed.reports);
    if (!parsed.hasNext || parsed.reports.some(r => known.has(r.sourceId))) return { source, reports, truncated: false };
    if (parsed.nextUrl) current = parsed.nextUrl;
  }
  return { source, reports, truncated: true };
}

export async function resolveBrokerPdf(r: IndustryReport, fetcher: typeof fetch): Promise<IndustryReport> {
  if (r.source !== "sangsang" || r.pdfUrl) return r;
  if (!digits(r.sourceId)) return fail("sangsang", "상세 요청 ID가 올바르지 않습니다.");
  const text = await read("sangsang", "https://www.sangsanginib.com/notice/getNoticeDetail", fetcher, post({
    cmsCd: "CM0338", ntNo: r.sourceId, src: "all", startRow: "0", rowNum: "10", pageNum: "1", sdt: "", edt: "",
  }));
  let data: Record<string, any>; try { data = object(JSON.parse(text), "sangsang"); } catch { return fail("sangsang", "상세 응답이 올바르지 않습니다."); }
  if (String(data.notice?.NT_NO) !== r.sourceId || data.notice?.CMS_CD !== "CM0338" || !Array.isArray(data.file)) return fail("sangsang", "요청한 산업 보고서의 상세 ID와 다릅니다.");
  const file = data.file.find((f: any) => /\.pdf$/iu.test(String(f.FNM)) && f.CMS_CD === "CM0338" && String(f.NT_NO) === r.sourceId && digits(f.FNO));
  return { ...r, excerpt: plain(data.notice.CONTS).slice(0, 12000),
    ...(file ? { pdfUrl: `https://www.sangsanginib.com/_upload/attFile/CM0338/CM0338_${r.sourceId}_${file.FNO}.pdf` } : {}) };
}

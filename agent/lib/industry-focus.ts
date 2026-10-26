import { compact } from "./report-bot.ts";
import type { Decision } from "./industry-filter.ts";
import type { IndustryReport } from "./industry-sources.ts";

// Domestic research publishers, including former names found in older uploads.
// Checked against KOFIA's securities member directory on 2026-10-26.
const domesticBrokers = new Set([
  "DB증권", "DB금융투자", "DS투자증권", "KB증권", "NH투자증권", "교보증권",
  "넥스트증권", "다올투자증권", "KTB투자증권", "대신증권", "리딩투자증권",
  "메리츠증권", "미래에셋증권", "미래에셋대우", "부국증권", "BNK투자증권",
  "비엔케이투자증권", "삼성증권", "상상인증권", "신영증권", "신한투자증권",
  "신한금융투자", "IBK투자증권", "아이비케이투자증권", "iM증권", "아이엠증권",
  "하이투자증권", "SK증권", "에스케이증권", "LS증권", "엘에스증권",
  "이베스트투자증권", "우리투자증권", "유안타증권", "유진투자증권", "유화증권",
  "카카오페이증권", "KR투자증권", "케이알투자증권", "케이프투자증권",
  "코리아에셋투자증권", "키움증권", "토스증권", "하나증권", "하나금융투자",
  "한국투자증권", "한화투자증권", "현대차증권", "흥국증권",
].map(value => value.toLowerCase()));

export function classifyDomesticIssuer(report: IndustryReport): Decision {
  const name = report.broker.normalize("NFKC").replace(/주식회사|\(주\)|㈜|\s/gu, "").toLowerCase();
  return domesticBrokers.has(name)
    ? { status: "eligible", reason: `국내 증권사 발행: ${report.broker}` }
    : { status: "review", reason: `국내 증권사 발행 여부를 확인해야 합니다: ${report.broker}` };
}

// Aliases help with Korean prose without a ticker. They are clues, not a market-cap
// whitelist. Explicit US exchange / ticker suffix notation also covers other stocks.
// Listing references: https://www.sec.gov/files/company_tickers_exchange.json
const companies: [string, RegExp][] = [
  ["NVDA", /엔비디아|\bNVIDIA\b|\bNVDA\b/giu],
  ["MSFT", /마이크로소프트|\bMicrosoft\b|\bMSFT\b/giu],
  ["AMZN", /아마존|\bAmazon\b|\bAMZN\b/giu],
  ["AAPL", /애플|\bApple\b|\bAAPL\b/giu],
  ["GOOGL", /알파벳|구글|\bAlphabet\b|\bGoogle\b|\bGOOGL?\b/giu],
  ["META", /메타\s*플랫폼스|\bMeta\s+Platforms\b|\bMETA\b/giu],
  ["TSLA", /테슬라|\bTesla\b|\bTSLA\b/giu],
  ["AVGO", /브로드컴|\bBroadcom\b|\bAVGO\b/giu],
  ["AMD", /\bAMD\b|어드밴스드\s*마이크로\s*디바이스/giu],
  ["MU", /마이크론|\bMicron\b/giu],
  ["ORCL", /오라클|\bOracle\b|\bORCL\b/giu],
  ["PLTR", /팔란티어|\bPalantir\b|\bPLTR\b/giu],
  ["LLY", /일라이\s*릴리|\bEli\s+Lilly\b|\bLLY\b/giu],
  ["QCOM", /퀄컴|\bQualcomm\b|\bQCOM\b/giu],
  ["NFLX", /넷플릭스|\bNetflix\b|\bNFLX\b/giu],
  ["CRM", /세일즈포스|\bSalesforce\b/giu],
  ["GEV", /GE\s*버노바|\bGE\s+Vernova\b|\bGEV\b/giu],
  ["VRT", /버티브|\bVertiv\b/giu],
  ["ETN", /이튼|\bEaton\b/giu],
];
const sector = /산업|업종|반도체|AI\b|인공지능|클라우드|소프트웨어|데이터\s*센터|전력|원전|원자력|에너지|태양광|전기차|자동차|배터리|이차전지|헬스케어|의료|바이오|제약|방산|우주|항공|소비재|유통|리테일|은행|금융|결제|플랫폼|인터넷|통신|로봇|물류|부동산|리츠|식품|엔터테인먼트|게임|semiconductor|industry|sector|software|healthcare|energy|utilities|retail|defen[cs]e/iu;
const analysis = /매출|영업이익|수익성|점유율|경쟁력|밸류체인|수요|공급|성장|설비투자|CAPEX|실적|밸류에이션|전망|revenue|earnings|margin|market\s*share|valuation|forecast|outlook/giu;
const narrative = /(?:전망|예상|분석|판단|추정|기대|강화|확대|증가|감소|개선|성장|수요)[^\n.!?。]{0,70}(?:다[.\s]|습니다)|\b(?:expected\s+to|we\s+expect|is\s+forecast|projected\s+to)\b/iu;

function usIndustrySubject(text: string): boolean {
  if (/미국\s*(?:주식|증시|상장)|\bU\.?S\.?\s+equit(?:y|ies)\b/iu.test(text)) return true;
  for (const match of text.matchAll(/미국|북미|\bU\.?S\.?\b|\bUnited\s+States\b|\bNorth\s+America\b/giu)) {
    const nearby = text.slice(match.index! + match[0].length, match.index! + match[0].length + 55);
    const topic = nearby.match(sector);
    if (!topic) continue;
    const before = nearby.slice(0, topic.index);
    if (!/국내|한국|중국|일본|금리|국채|환율|FOMC|CPI|통화정책/iu.test(before)) return true;
  }
  return false;
}

function stockHits(text: string): { ticker: string; index: number }[] {
  const hits: { ticker: string; index: number }[] = [];
  for (const [ticker, pattern] of companies) {
    for (const match of text.matchAll(pattern)) hits.push({ ticker, index: match.index! });
  }
  const notation = /\b(?:NASDAQ|NYSE|AMEX)\s*[:：]\s*([A-Z][A-Z0-9.-]{0,7})\b|\b([A-Z][A-Z0-9.-]{0,7}?)\s*(?:US\b|\.US\b|\.OQ?\b|\.N\b)/gu;
  for (const match of text.matchAll(notation)) hits.push({ ticker: match[1] || match[2], index: match.index! });
  return hits.filter((hit, i) => hits.findIndex(other => other.index === hit.index && other.ticker === hit.ticker) === i);
}

export function classifyUsFocus(report: IndustryReport): Decision {
  const title = report.title.normalize("NFKC");
  if (usIndustrySubject(title)) return { status: "eligible", reason: `미국 산업·주식 중심 제목: ${compact(title).slice(0, 90)}` };
  const titleStocks = stockHits(title);
  if (titleStocks.length) return { status: "eligible", reason: `산업 제목의 미국 종목: ${[...new Set(titleStocks.map(x => x.ticker))].join(", ")}` };
  // Inspect page/paragraph blocks, keeping tables, source notes and disclaimers
  // from qualifying on a name alone. The complete PDF remains unchanged.
  const text = (report.analysisText || report.coverText || "").normalize("NFKC");
  for (const raw of text.split(/\f|\n\s*\n/u)) {
    const lines = raw.split("\n").filter(line => !/^\s*(?:자료\s*[:：]|출처\s*[:：]|Source\s*[:：]|Compliance|면책|투자등급)/iu.test(line));
    const block = lines.join("\n");
    if (block.length < 180 || !narrative.test(block) || [...block.matchAll(analysis)].length < 2) continue;
    if (usIndustrySubject(block)) return { status: "eligible", reason: "PDF 본문에서 미국 산업의 전망·수요·실적 분석을 확인했습니다." };
    const hits = stockHits(block);
    const frequent = [...new Set(hits.map(hit => hit.ticker))].filter(ticker => hits.filter(hit => hit.ticker === ticker).length >= 2);
    if (frequent.length) return { status: "eligible", reason: `PDF 본문의 미국 종목 분석: ${frequent.slice(0, 5).join(", ")}` };
  }
  return { status: "review", reason: "미국 산업 또는 미국 종목을 주요하게 분석했다는 본문 근거가 부족합니다." };
}

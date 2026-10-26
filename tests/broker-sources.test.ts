import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseHana, parseMirae, parseYuanta, parseKyobo, parseHanyang, parseToss, parseSangsang, parseHyundai } from "../agent/lib/broker-sources.ts";
import { checkedPdfUrl, collectSource, resolvePdf } from "../agent/lib/industry-sources.ts";
import { configuredSources, DEFAULT_SOURCES } from "../agent/lib/source-config.ts";
import { classifyIndustry, industryCaption } from "../agent/lib/industry-filter.ts";
import { IndustryStore } from "../agent/lib/industry-store.ts";

const fixture = (name: string) => readFile(new URL(`fixtures/${name}`, import.meta.url), "utf8");
const json = async (name: string) => JSON.parse(await fixture(name));

test("하나 글로벌 산업 목록의 등록 ID·일자·첨부 원문을 해석합니다", async () => {
  const p = parseHana(await fixture("hana.html"));
  assert.equal(p.reports[0].sourceId, "1289264");
  assert.equal(p.reports[0].published, "2026-10-25");
  assert.equal(p.reports[0].broker, "하나증권");
  assert.match(p.reports[0].pdfUrl!, /bbsSeq=1289264/);
  assert.equal(p.hasNext, true);
});
test("미래에셋은 게시물 ID를 첨부 ID와 구분하고 실제 다음 페이지 주소를 유지합니다", async () => {
  const p = parseMirae(await fixture("mirae.html"));
  assert.equal(p.reports[0].sourceId, "2343642");
  assert.match(p.reports[2].title, /게임/);
  assert.match(p.reports[2].pdfUrl!, /2147956/);
  assert.equal(classifyIndustry(p.reports[1]).status, "excluded");
  assert.match(p.nextUrl!, /curPage=2/);
  assert.match(p.nextUrl!, /startId=/);
});
test("유안타는 산업 분류 RE02 확인 후 원문 경로를 해석합니다", async () => {
  const h = await fixture("yuanta.html"), p = parseYuanta(h);
  assert.equal(p.reports[0].category, "산업");
  assert.equal(p.reports[0].sourceId, "207957");
  assert.ok(!p.reports[0].title.includes("본 내용은"));
  assert.match(p.reports[0].pdfUrl!, /ATTACH_FILE=2026%2F1026/);
  assert.throws(() => parseYuanta(h.replace('cd007:"RE02"', 'cd007:"RE01"')), /산업분석/);
});
test("교보의 혼합 최신 목록에서 기업분석을 산업분석으로 바꾸지 않습니다", async () => {
  const p = parseKyobo(await fixture("kyobo.html"));
  assert.equal(p.reports[0].category, "기업분석");
  assert.equal(classifyIndustry(p.reports[0]).status, "excluded");
  assert.equal(p.reports[1].category, "산업");
  assert.match(p.reports[1].pdfUrl!, /RSDownloadServlet/);
  assert.match(p.nextUrl!, /pageNum=2/);
});
test("한양의 오래된 발간일을 오늘 날짜로 바꾸지 않고 세션 식별자를 제거합니다", async () => {
  const p = parseHanyang(await fixture("hanyang.html"));
  assert.equal(p.reports[2].sourceId, "726");
  assert.equal(p.reports[2].published, "2025-01-15");
  assert.match(p.reports[2].title, /우주/);
  assert.doesNotMatch(p.reports[2].sourceUrl, /jsessionid/);
});
test("토스 인사이트의 산업 범위와 원문 첨부를 확인하며 일반 시장 자료는 구분합니다", async () => {
  const input = await json("toss.json"), p = parseToss(input);
  assert.equal(p.reports[0].sourceId, "21460");
  assert.equal(p.reports[0].category, "산업");
  assert.equal(classifyIndustry(p.reports[0]).status, "eligible");
  assert.match(p.reports[0].pdfUrl!, /home-files\.tossinvest\.com/);
  const general = structuredClone(input); general.result.list[0].title = "QnA 2026"; general.result.list[0].contents = "일반 주식시장 전망";
  assert.equal(parseToss(general).reports[0].category, "기타");
  const wrong = structuredClone(input); wrong.result.list[0].category.id = 154;
  assert.throws(() => parseToss(wrong), /인사이트/);
  assert.throws(() => parseToss(input, 2), /페이지/);
});
test("현대차 목록의 실제 산업 코드 202만 산업분석으로 처리합니다", async () => {
  const p = parseHyundai(await json("hyundai.json"));
  assert.equal(p.reports[0].category, "기타");
  assert.equal(p.reports[2].category, "산업");
  assert.equal(p.reports[2].sourceId, "36535");
  assert.equal(p.reports[2].published, "2026-10-23");
  assert.match(p.reports[2].pdfUrl!, /20261022174554880_ko\.pdf$/);
});
test("상상인 상세 요청은 전체 필수 검색 인자를 보내고 ID·분류·첨부를 검증합니다", async () => {
  const p = parseSangsang(await json("sangsang.json")), r = p.reports[0], detail = await json("sangsang-detail.json");
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(String(url), "https://www.sangsanginib.com/notice/getNoticeDetail");
    assert.equal(init?.method, "POST");
    const params = new URLSearchParams(String(init.body));
    for (const field of ["rowNum", "startRow", "pageNum", "sdt", "edt", "src"]) assert.equal(params.has(field), true);
    assert.equal(params.get("ntNo"), "899");
    return Response.json(detail);
  };
  assert.match((await resolvePdf(r, fetcher)).pdfUrl!, /CM0338_899_1\.pdf$/);
  await assert.rejects(resolvePdf(r, async () => Response.json({ ...detail, notice: { ...detail.notice, NT_NO: 898 } })), /ID/);
});
test("새 출처도 이전 등록 ID에서 멈추며 같은 페이지 반복은 수집 실패로 표시합니다", async () => {
  const first = await json("sangsang.json"), second = structuredClone(first); second[0].getNoticeList[0].NT_NO = 889;
  let calls = 0;
  const result = await collectSource("sangsang", { known: new Set(["889"]), fetcher: async (_url, init) => {
    const body = new URLSearchParams(String(init?.body)); assert.equal(body.get("startRow"), String(calls * 10));
    return Response.json(calls++ ? second : first);
  } });
  assert.equal(calls, 2); assert.equal(result.truncated, false);
  await assert.rejects(collectSource("sangsang", { fetcher: async () => Response.json(first) }), /PAGINATION/);
});
test("목록의 외부 호스트 이동·로그인 화면·스키마 변경을 빈 결과로 숨기지 않습니다", async () => {
  await assert.rejects(collectSource("toss", { fetcher: async () => new Response("", { status: 302, headers: { location: "https://evil.test/private" } }) }), /SOURCE_URL/);
  await assert.rejects(collectSource("toss", { fetcher: async () => new Response("<form>로그인</form>") }), /로그인/);
  for (const parse of [parseHana, parseMirae, parseKyobo, parseHanyang]) assert.throws(() => parse("<h1>접속 제한</h1>"), /LAYOUT/);
  assert.throws(() => parseSangsang([{ getCount: 5, getNoticeList: [] }]), /LAYOUT/);
  assert.throws(() => parseHyundai({ data_list: [], curPage: 1, paging: { totalPages: 5 } }), /LAYOUT/);
});
test("공개 PDF 호스트만 허용하며 로그인 경로가 필요한 증권사는 자동 출처로 등록하지 않습니다", () => {
  assert.equal(DEFAULT_SOURCES.length, 10);
  assert.deepEqual(configuredSources("toss,hana,toss"), ["toss", "hana"]);
  for (const s of ["hanwha", "daishin", "samsung", "unknown", ""]) assert.throws(() => configuredSources(s));
  for (const url of ["https://home-files.tossinvest.com/a.pdf", "https://file.hanaw.com/a.pdf", "https://file.myasset.com/a.pdf"]) assert.equal(checkedPdfUrl(url), url);
  for (const url of ["http://home-files.tossinvest.com/a.pdf", "https://u:p@home-files.tossinvest.com/a.pdf", "https://home-files.tossinvest.com:8443/a.pdf", "https://home-files.tossinvest.com.evil.test/a.pdf"]) assert.throws(() => checkedPdfUrl(url), /PDF_URL/);
});
test("추가 출처의 기준점을 저장하며 기존 PDF 중복 방지와 출처 표시를 공유합니다", async () => {
  const r = parseToss(await json("toss.json")).reports[0], store = new IndustryStore();
  try {
    assert.equal(store.ingest({ source: "toss", reports: [r], truncated: false }).seeded, 1);
    assert.equal(store.pending("labels-v1", 20, Date.now(), ["toss"]).length, 0);
    const candidate = { ...r, sourceId: "999", pdfHash: "same-pdf" };
    store.ingest({ source: "toss", reports: [candidate], truncated: false });
    assert.equal(store.pending("labels-v1", 20, Date.now(), ["toss"]).length, 1);
    assert.equal(store.claim(candidate).acquired, true);
    assert.equal(store.claim({ ...candidate, source: "naver" }).acquired, false);
    assert.match(industryCaption(r, { status: "eligible", reason: "테스트" }), /등록사이트: 토스증권/);
  } finally { store.close(); }
});

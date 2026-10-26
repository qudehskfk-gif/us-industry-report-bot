import test from "node:test";
import assert from "node:assert/strict";
import { parsePublicChannel, collectPublicChannels, resolveChannelPdf, channelPublisherMatches } from "../agent/lib/public-channels.ts";
import { fetchPublicResource } from "../agent/lib/public-http.ts";
import { classifyIndustry, industryCaption } from "../agent/lib/industry-filter.ts";
import type { IndustryReport } from "../agent/lib/industry-sources.ts";

function post(channel = "KISemicon", id = 4742, content = "[한투증권 김정찬] 광통신: 더 가까이, 더 멀리<br>이번 인뎁스에서 미국 광통신 산업과 레이저칩 병목을 분석합니다.<br>자료: <a href='https://zrr.kr/report'>원문</a>") {
  return `<div class='tgme_widget_message' data-post='${channel}/${id}'><div class='tgme_widget_message_text'>${content}</div><a class='tgme_widget_message_date'><time datetime='2026-10-26T17:34:00+00:00'></time></a></div>`;
}
const sample = (): IndustryReport => ({ source: "meritz", sourceId: "meritz_research/1/abc", sourceUrl: "https://t.me/meritz_research/1", url: "https://t.me/meritz_research/1", published: "2026-10-27", broker: "메리츠증권", title: "반도체 In-Depth", category: "산업", sector: "반도체", code: "", author: "", pdfUrl: "https://buly.kr/report" });

test("공개 채널의 게시물 ID·한국 게시일·실제 제목과 보고서 링크를 읽습니다", () => {
  const parsed = parsePublicChannel(post(), "korea", "KISemicon");
  assert.equal(parsed.reports.length, 1);
  const r = parsed.reports[0];
  assert.equal(r.title, "광통신: 더 가까이, 더 멀리");
  assert.equal(r.published, "2026-10-27");
  assert.equal(r.broker, "한국투자증권");
  assert.equal(r.category, "산업");
  assert.match(r.sourceId, /^KISemicon\/4742\//);
  assert.match(industryCaption(r, { status: "review", reason: "검사" }), /게시일: 2026-10-27/);
});

test("같은 게시물의 서로 다른 PDF는 구분하고 반복 링크는 중복 수집하지 않습니다", () => {
  const html = post("KiwoomResearch", 1, "반도체 산업 In-Depth<br><a href='https://bbn.kiwoom.com/rfCI123'>원문</a><a href='https://bbn.kiwoom.com/rfCI123'>원문 반복</a><a href='https://bbn.kiwoom.com/rfCI124'>부록</a>");
  const rows = parsePublicChannel(html, "kiwoom", "KiwoomResearch").reports;
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].sourceId, rows[1].sourceId);
});

test("뉴스 단축 링크·외부 파일·텔레그램 첨부 전용 파일은 PDF 원문으로 등록하지 않습니다", () => {
  const html = post("KISemicon", 1, "반도체 산업 뉴스<br>새로운 공장 가동 (뉴스) <a href='https://vo.la/news'>뉴스</a><br><a href='https://untrusted.example/file.pdf'>원문</a><a href='https://t.me/KISemicon/1'>첨부 PDF</a>");
  assert.equal(parsePublicChannel(html, "korea", "KISemicon").reports.length, 0);
});

test("개별 기업과 Weekly 자료는 공개 채널에서도 발송 후보에서 제외합니다", () => {
  const company = post("KiwoomResearch", 1, "[키움 반도체 연구원]<br>삼성전자(005930): 목표주가 상향<br>산업 인뎁스 참고<br>보고서: <a href='https://bbn.kiwoom.com/rfCR1'>원문</a>");
  assert.equal(classifyIndustry(parsePublicChannel(company, "kiwoom", "KiwoomResearch").reports[0]).status, "excluded");
  const weekly = post("meritz_research", 1, "📮[메리츠증권 반도체 연구원]<br>2026.10.26(월)<br>반도체 Weekly<br>보고서: <a href='https://buly.kr/weekly'>원문</a>");
  const r = parsePublicChannel(weekly, "meritz", "meritz_research").reports[0];
  assert.equal(r.title, "반도체 Weekly");
  assert.equal(classifyIndustry(r).status, "excluded");
});

test("산업 투자의견은 기업 티커로 오인하지 않고 기업 TP 표기는 구분합니다", () => {
  const industry = post("meritz_research", 2, "반도체(Overweight) - 산업 In-Depth<br>자료: <a href='https://buly.kr/sector'>원문</a>");
  assert.equal(parsePublicChannel(industry, "meritz", "meritz_research").reports[0].category, "산업");
  const company = post("nhis_bio", 2, "[셀트리온(TP 270,000원 유지, Buy 유지)] 불안하면 셀트리온으로<br>자료: <a href='https://m.nhsec.com/c/report'>원문</a>");
  assert.equal(parsePublicChannel(company, "nh", "nhis_bio").reports[0].category, "기업");
});

test("접속 제한 화면·다른 채널 ID·외부 페이지 이동을 정상 목록으로 숨기지 않습니다", () => {
  assert.throws(() => parsePublicChannel("<title>Site Unavailable</title>", "korea", "KISemicon"), /접속 제한/);
  assert.throws(() => parsePublicChannel(post("OtherChannel"), "korea", "KISemicon"), /게시물 ID/);
  assert.throws(() => parsePublicChannel(post() + "<a class='tme_messages_more' href='https://untrusted.example/?before=1'></a>", "korea", "KISemicon"), /이전 페이지/);
});

test("기존 등록 지점에서 공개 채널 탐색을 멈춥니다", async () => {
  const html = post() + "<a class='tme_messages_more' href='/s/KISemicon?before=4742'></a>";
  const row = parsePublicChannel(html, "korea", "KISemicon").reports[0];
  let calls = 0;
  const result = await collectPublicChannels("korea", { known: new Set([row.sourceId]), maxPages: 1,
    fetcher: async url => { calls++; return new Response(String(url).includes("enc210406") ? post("enc210406", 1, "산업 뉴스") : html); },
  });
  assert.equal(calls, 2);
  assert.equal(result.truncated, false);
});

test("단축 주소의 원문은 해당 증권사의 HTTPS 파일 서버에서만 받습니다", async () => {
  const requests: string[] = [];
  const r = await resolveChannelPdf(sample(), async url => {
    requests.push(String(url));
    return requests.length === 1 ? new Response(null, { status: 302, headers: { location: "http://home.imeritz.com/include/resource/research/WorkFlow/report.pdf" } })
      : new Response("%PDF-test", { headers: { "content-type": "application/pdf" } });
  });
  assert.match(r.pdfUrl!, /^https:\/\/home\.imeritz\.com\//);
  assert.equal(requests.every(url => url.startsWith("https://")), true);
});

test("사설 주소·다른 발행사 파일·로그인 화면으로는 원문 수집을 진행하지 않습니다", async () => {
  for (const target of ["https://127.0.0.1/file.pdf", "https://file.truefriend.com/file.pdf", "https://x:secret@home.imeritz.com/file.pdf"]) {
    let calls = 0;
    await assert.rejects(resolveChannelPdf(sample(), async () => { calls++; return new Response(null, { status: 302, headers: { location: target } }); }), /허용된/);
    assert.equal(calls, 1);
  }
  await assert.rejects(resolveChannelPdf(sample(), async () => new Response("<html><body>로그인 후 이용해 주세요</body></html>")), /공개 원문/);
});

test("PDF의 발행사 확인은 공개 채널 이름과 별도로 검사합니다", () => {
  assert.equal(channelPublisherMatches("korea", "Korea Investment & Securities Research"), true);
  assert.equal(channelPublisherMatches("korea", "Example foreign broker research"), false);
  assert.equal(channelPublisherMatches("kiwoom", "키움증권 리서치센터"), true);
  assert.equal(channelPublisherMatches("shinhan", "Shinhan Securities Research"), true);
});

test("공개 배포된 신한 PDF 링크는 HTTPS로 요청하고 개별 기업 분류를 유지합니다", async () => {
  const html = post("shinhanresearch", 1, "『CJ CGV (079160.KS) - 3Q26 Review』<br>※ 원문 확인: <a href='http://bbs2.shinhansec.com/board/message/file.pdf.do?attachmentId=354498'>원문</a>");
  const row = parsePublicChannel(html, "shinhan", "shinhanresearch").reports[0];
  assert.match(row.pdfUrl!, /^https:\/\/bbs2\.shinhansec\.com\//);
  assert.equal(classifyIndustry(row).status, "excluded");
  const result = await resolveChannelPdf(row, async url => {
    assert.match(String(url), /^https:\/\/bbs2\.shinhansec\.com\//);
    return new Response("%PDF-test", { headers: { "content-type": "application/pdf" } });
  });
  assert.equal(result.pdfUrl, row.pdfUrl);
});

test("일시적인 공개 조회 연결 오류는 한 번만 다시 요청합니다", async () => {
  let calls = 0;
  const response = await fetchPublicResource("https://www.hanaw.com/public", {}, { fetcher: async () => {
    calls++; if (calls === 1) throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
    return new Response("ok");
  } });
  assert.equal(calls, 2); assert.equal(await response.text(), "ok");
});

test("접근 거절·속도 제한과 일반 POST는 자동 반복하지 않습니다", async () => {
  for (const status of [401, 403, 429]) {
    let calls = 0; const response = await fetchPublicResource("https://public.example/", {}, { fetcher: async () => { calls++; return new Response("restricted", { status }); } });
    assert.equal(calls, 1); assert.equal(response.status, status);
  }
  let calls = 0;
  await assert.rejects(fetchPublicResource("https://public.example/", { method: "POST" }, { fetcher: async () => {
    calls++; throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
  } }));
  assert.equal(calls, 1);
});

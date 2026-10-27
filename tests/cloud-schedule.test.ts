import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndustryStore } from "../agent/lib/industry-store.ts";
import { checkCloudStatePath, cloudRunOptions, runScheduledIndustry } from "../agent/lib/cloud-schedule.ts";
import type { ScanResult } from "../agent/lib/cloud-schedule.ts";
import type { IndustryReport, Source, SourceResult } from "../agent/lib/industry-sources.ts";
import { processIndustry } from "../agent/lib/industry-bot.ts";
import { INDUSTRY_POLICY } from "../agent/lib/industry-filter.ts";

process.env.INDUSTRY_SOURCES = "hankyung,naver";

const sample = (source: Source): IndustryReport => ({
  source, sourceId: "1", sourceUrl: "https://stock.naver.com/research/industry/1", url: "https://stock.naver.com/research/industry/1",
  title: "산업 In-Depth", published: "2026-10-25", broker: "예시증권", author: "예시", code: "", category: "산업", sector: "반도체",
});
const collect = async (source: Source): Promise<SourceResult> => ({ source, reports: [sample(source)], truncated: false });
const success = (): ScanResult => ({ errors: 0, uncertain: 0, sourceErrors: [], coverageWarnings: [] });
const atFive = new Date("2026-10-26T08:00:00Z");
const warm = (store: IndustryStore) => {
  for (const source of ["hankyung", "naver"] as Source[]) store.ingest({ source, reports: [sample(source)], truncated: false });
};

test("설치 시간이 오후 5시 밖이면 기준점만 저장하고 발송하지 않습니다", async () => {
  const store = new IndustryStore(); let calls = 0;
  try {
    const result = await runScheduledIndustry({ store, collect, now: new Date("2026-10-25T13:00:00Z"), scan: async () => { calls++; return success(); } });
    assert.equal(result.status, "outside_window"); assert.equal(result.seeded, 2); assert.equal(calls, 0);
    assert.equal(store.pending("labels-v1").length, 0);
    assert.equal(store.status().scanRuns.length, 0);
  } finally { store.close(); }
});
test("한국시간 오후 5시에 정기 조회와 발송 작업을 실행합니다", async () => {
  const store = new IndustryStore(); let calls = 0;
  try {
    const result = await runScheduledIndustry({ store, collect, now: atFive, scan: async () => { calls++; return success(); } });
    assert.equal(result.status, "complete"); assert.equal(result.day, "2026-10-26"); assert.equal(calls, 1);
    assert.equal(store.status().scanRuns[0].status, "complete");
  } finally { store.close(); }
});
test("상태를 복원한 뒤에도 같은 날 새 수집을 실행하고 모든 실행을 따로 기록합니다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "industry-cloud-")); let calls = 0;
  let store = new IndustryStore(join(dir, "state.sqlite"));
  const scan = async () => { calls++; return success(); };
  try {
    await runScheduledIndustry({ store, collect, now: atFive, scan });
    store.close(); store = new IndustryStore(join(dir, "state.sqlite"));
    const repeated = await runScheduledIndustry({ store, collect, now: new Date("2026-10-26T08:30:00Z"), scan });
    assert.equal(repeated.status, "complete"); assert.equal(calls, 2);
    await runScheduledIndustry({ store, collect, now: new Date("2026-10-27T08:00:00Z"), scan });
    assert.equal(calls, 3); assert.equal(store.status().scanRuns.length, 3);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("동일 시각의 별도 수집도 날짜 제한으로 막거나 실행 기록을 덮어쓰지 않습니다", async () => {
  const store = new IndustryStore(); warm(store);
  let release!: () => void; let entered!: () => void; let calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const running = new Promise<void>(resolve => { entered = resolve; });
  try {
    const first = runScheduledIndustry({ store, collect, now: atFive, scan: async () => { calls++; entered(); await gate; return success(); } });
    await running;
    const second = await runScheduledIndustry({ store, collect, now: atFive, scan: async () => { calls++; return success(); } });
    assert.equal(second.status, "complete"); assert.equal(calls, 2);
    release(); assert.equal((await first).status, "complete");
    assert.equal(store.status().scanRuns.length, 2);
    assert.ok(store.status().scanRuns.every(run => run.status === "complete"));
  } finally { release(); store.close(); }
});
test("실패 후 같은 날 다시 수집하며 앞선 실패 기록을 보존합니다", async () => {
  const store = new IndustryStore(); warm(store); let calls = 0;
  try {
    const failed = await runScheduledIndustry({ store, collect, now: atFive, scan: async () => { calls++; throw new Error("실행 실패"); } });
    assert.equal(failed.status, "failed"); assert.equal(store.status().scanRuns[0].status, "failed");
    const sameDay = await runScheduledIndustry({ store, collect, now: atFive, scan: async () => { calls++; return success(); } });
    assert.equal(sameDay.status, "complete"); assert.equal(calls, 2);
    assert.deepEqual(store.status().scanRuns.map(run => run.status), ["complete", "failed"]);
    const tomorrow = await runScheduledIndustry({ store, collect, now: new Date("2026-10-27T08:00:00Z"), scan: async () => { calls++; return success(); } });
    assert.equal(tomorrow.status, "complete"); assert.equal(calls, 3);
  } finally { store.close(); }
});
test("한 사이트의 첫 접속 실패는 다른 사이트의 정기 실행을 막지 않습니다", async () => {
  const store = new IndustryStore(); let calls = 0;
  try {
    const result = await runScheduledIndustry({ store, now: atFive,
      collect: async source => { if (source === "hankyung") throw new Error("차단"); return collect(source); },
      scan: async () => { calls++; return success(); },
    });
    assert.equal(result.status, "partial"); assert.equal(calls, 1);
    assert.deepEqual(result.baselineErrors, ["hankyung"]);
  } finally { store.close(); }
});
test("모든 사이트의 기준점 수집이 실패하면 성공 실행으로 기록하지 않습니다", async () => {
  const store = new IndustryStore(); let calls = 0;
  try {
    const result = await runScheduledIndustry({ store, now: atFive, collect: async () => { throw new Error("차단"); }, scan: async () => { calls++; return success(); } });
    assert.equal(result.status, "baseline_error"); assert.equal(calls, 0);
    assert.equal(store.status().scanRuns.length, 0);
  } finally { store.close(); }
});
test("영구 Volume이 없거나 상태 파일이 Volume 밖에 있으면 운영을 거부합니다", () => {
  assert.throws(() => checkCloudStatePath("./data/state.sqlite", true, "/data"), /절대 경로/);
  assert.throws(() => checkCloudStatePath("/data/state.sqlite", true), /Volume/);
  assert.throws(() => checkCloudStatePath("/data2/state.sqlite", true, "/data"), /내부/);
  assert.throws(() => checkCloudStatePath("/data/../tmp/state.sqlite", true, "/data"), /내부/);
  assert.doesNotThrow(() => checkCloudStatePath("/data/state.sqlite", true, "/data"));
});

test("지연된 GitHub 예약 실행도 기존 당일 수집 여부와 관계없이 처리합니다", async () => {
  const store = new IndustryStore(); warm(store); let calls = 0;
  try {
    const result = await runScheduledIndustry({ store, collect, now: new Date("2026-10-26T09:10:00Z"), allowLate: true,
      scan: async () => { calls++; return success(); } });
    assert.equal(result.status, "complete"); assert.equal(calls, 1);
    const repeated = await runScheduledIndustry({ store, collect, now: new Date("2026-10-26T10:00:00Z"), allowLate: true,
      scan: async () => { calls++; return success(); } });
    assert.equal(repeated.status, "complete"); assert.equal(calls, 2);
  } finally { store.close(); }
});
test("수동 초기화는 오후 5시에 실행해도 리포트를 발송하지 않습니다", async () => {
  const store = new IndustryStore(); let calls = 0;
  try {
    const result = await runScheduledIndustry({ store, collect, now: atFive, initializeOnly: true,
      scan: async () => { calls++; return success(); } });
    assert.equal(result.status, "initialized"); assert.equal(calls, 0);
    assert.equal(store.status().scanRuns.length, 0);
  } finally { store.close(); }
});

test("GitHub 수동 실행은 한국시간 자정 직후와 오전, 오후 6시 이후에도 수집합니다", async () => {
  const timing = cloudRunOptions({ GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", RUN_MODE: "scheduled" });
  for (const time of ["2026-10-26T15:01:00Z", "2026-10-27T00:00:00Z", "2026-10-27T09:30:00Z", "2026-10-27T14:59:00Z"]) {
    const store = new IndustryStore(); warm(store); let calls = 0;
    try {
      const result = await runScheduledIndustry({ store, collect, now: new Date(time), ...timing,
        scan: async () => { calls++; return success(); } });
      assert.equal(result.status, "complete", time); assert.equal(result.day, "2026-10-27");
      assert.equal(calls, 1); assert.equal(store.status().scanRuns.length, 1);
    } finally { store.close(); }
  }
});

test("오전 10시 수동 실행 후 오후 5시 예약과 추가 수동 실행을 각각 처리합니다", async () => {
  const manual = cloudRunOptions({ GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", RUN_MODE: "scheduled" });
  const scheduled = cloudRunOptions({ GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "schedule", RUN_MODE: "scheduled" });
  for (const pair of [
    [{ time: "2026-10-27T01:00:00Z", timing: manual }, { time: "2026-10-27T08:00:00Z", timing: scheduled }],
    [{ time: "2026-10-27T09:30:00Z", timing: manual }, { time: "2026-10-27T10:00:00Z", timing: scheduled }],
    [{ time: "2026-10-27T08:00:00Z", timing: scheduled }, { time: "2026-10-27T09:30:00Z", timing: manual }],
    [{ time: "2026-10-27T00:00:00Z", timing: manual }, { time: "2026-10-27T09:30:00Z", timing: manual }],
  ]) {
    const store = new IndustryStore(); warm(store); let calls = 0;
    const scan = async () => { calls++; return success(); };
    try {
      const first = await runScheduledIndustry({ store, collect, now: new Date(pair[0].time), ...pair[0].timing, scan });
      const second = await runScheduledIndustry({ store, collect, now: new Date(pair[1].time), ...pair[1].timing, scan });
      assert.equal(first.status, "complete"); assert.equal(second.status, "complete");
      assert.equal(calls, 2); assert.equal(store.status().scanRuns.length, 2);
    } finally { store.close(); }
  }
});

test("시간 제한 해제는 GitHub 수동 발송에만 적용하고 수동 초기화는 계속 발송하지 않습니다", async () => {
  const now = new Date("2026-10-27T09:30:00Z");
  for (const env of [
    { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", RUN_MODE: "scheduled" },
    { GITHUB_ACTIONS: "false", GITHUB_EVENT_NAME: "workflow_dispatch", RUN_MODE: "scheduled" },
    { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", RUN_MODE: "initialize" },
  ]) {
    const store = new IndustryStore(); let calls = 0;
    try {
      const result = await runScheduledIndustry({ store, collect, now, ...cloudRunOptions(env),
        scan: async () => { calls++; return success(); } });
      assert.equal(result.status, env.RUN_MODE === "initialize" ? "initialized" : "outside_window");
      assert.equal(calls, 0); assert.equal(store.status().scanRuns.length, 0);
      assert.equal(store.pending("labels-v1").length, 0);
    } finally { store.close(); }
  }
});

test("기존 날짜별 실행 기록은 새 수집을 막지 않으며 원본 그대로 남습니다", async () => {
  const store = new IndustryStore(); warm(store);
  try {
    store.claimDay("2026-10-27");
    for (const status of ["running", "complete", "partial", "failed"]) {
      store.db.prepare("UPDATE industry_schedule_runs SET status=?,result_json=?").run(status, '{"sent":1}');
      const before = store.db.prepare("SELECT * FROM industry_schedule_runs").all();
      const result = await runScheduledIndustry({ store, collect, now: new Date("2026-10-27T01:00:00Z"), manualRun: true, scan: async () => success() });
      assert.equal(result.status, "complete");
      assert.deepEqual(store.db.prepare("SELECT * FROM industry_schedule_runs").all(), before);
    }
    assert.equal(store.status().scanRuns.length, 4);
  } finally { store.close(); }
});

test("오전 발송 후 상태를 복원하면 오후의 신규 PDF만 보내고 중복·과거 자료는 보내지 않습니다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "industry-repeat-"));
  const path = join(dir, "state.sqlite"); let store = new IndustryStore(path); warm(store);
  const report = (sourceId: string, hash: string): IndustryReport => ({ ...sample("naver"), sourceId,
    title: `미국 반도체 산업 전망 ${hash}`, broker: "하나증권", published: "2026-10-27", pages: 10, pdfHash: hash });
  const first = report("new-1", "pdf-a"); const second = report("new-2", "pdf-b");
  let listed = [first]; const sent: string[] = [];
  const scan = async (): Promise<ScanResult> => {
    store.ingest({ source: "naver", reports: listed, truncated: false });
    const result = await processIndustry(store.pending(INDUSTRY_POLICY, -1), { store, live: true,
      inspect: async r => ({ ...r, pdfBytes: new TextEncoder().encode(`%PDF-test-${r.pdfHash}`) }),
      sender: async document => { sent.push(document.filename); return String(sent.length); } });
    return { ...result, sourceErrors: [], coverageWarnings: [] };
  };
  try {
    const morning = await runScheduledIndustry({ store, collect, now: new Date("2026-10-27T01:00:00Z"), manualRun: true, scan });
    assert.equal(morning.result?.sent, 1);
    const baselines = store.status().sources;
    store.close(); store = new IndustryStore(path);
    listed = [first, second, { ...first, sourceId: "other-post-same-pdf" }];
    const evening = await runScheduledIndustry({ store, collect, now: new Date("2026-10-27T08:00:00Z"), scan });
    assert.equal(evening.result?.sent, 1); assert.equal(evening.result?.duplicates, 1);
    const again = await runScheduledIndustry({ store, collect, now: new Date("2026-10-27T09:00:00Z"), manualRun: true, scan });
    assert.equal(again.result?.sent, 0); assert.equal(again.result?.checked, 0);
    assert.equal(sent.length, 2); assert.equal(store.status().deliveries.length, 2);
    assert.deepEqual(store.status().sources, baselines);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM industry_observations WHERE status='seeded'").get()?.count, 2);
    assert.equal(store.status().scanRuns.length, 3);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("수동·예약·일회성 발송은 같은 GitHub 동시 실행 그룹으로 상태 복원을 직렬화합니다", () => {
  for (const path of ["industry-reports.yml", "requested-reviews.yml"]) {
    const workflow = readFileSync(new URL(`../.github/workflows/${path}`, import.meta.url), "utf8");
    assert.match(workflow, /concurrency:\s*\n\s+group: industry-reports-daily\s*\n\s+cancel-in-progress: false/u);
  }
});

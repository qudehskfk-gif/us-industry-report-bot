import { isAbsolute, relative, sep } from "node:path";
import { kstDay } from "./report-bot.ts";
import { collectSource } from "./industry-sources.ts";
import type { Source } from "./industry-sources.ts";
import { configuredSources } from "./source-config.ts";
import type { IndustryStore } from "./industry-store.ts";

export type ScanResult = {
  errors: number; uncertain: number; sourceErrors: unknown[]; coverageWarnings: string[];
  [key: string]: unknown;
};

export function cloudRunOptions(env: NodeJS.ProcessEnv = process.env) {
  const github = env.GITHUB_ACTIONS === "true";
  const initializeOnly = env.RUN_MODE === "initialize";
  return {
    initializeOnly,
    manualRun: github && env.GITHUB_EVENT_NAME === "workflow_dispatch" && !initializeOnly,
    allowLate: github && env.GITHUB_EVENT_NAME === "schedule",
  };
}

export function checkCloudStatePath(statePath: string, railway: boolean, mountPath?: string) {
  if (!isAbsolute(statePath) || statePath === ":memory:") throw new Error("STATE_PATH에 영구 저장소의 절대 경로를 설정해 주세요.");
  if (railway) {
    if (!mountPath || !isAbsolute(mountPath)) throw new Error("Railway 서비스에 영구 Volume을 연결해 주세요.");
    const inside = relative(mountPath, statePath);
    if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw new Error("STATE_PATH가 Railway Volume 내부를 가리켜야 합니다.");
    }
  }
}

export async function runScheduledIndustry(options: {
  store: IndustryStore; scan: () => Promise<ScanResult>; now?: Date;
  sources?: Source[]; maxPages?: number; collect?: typeof collectSource;
  initializeOnly?: boolean; allowLate?: boolean; manualRun?: boolean;
}) {
  const now = options.now || new Date();
  const sources = options.sources || configuredSources();
  const missing = sources.filter(source => !options.store.initialized(source));
  const fetched = await Promise.allSettled(missing.map(source => (options.collect || collectSource)(source, { maxPages: options.maxPages || 10 })));
  let seeded = 0;
  const baselineErrors: Source[] = [];
  for (let i = 0; i < fetched.length; i++) {
    const item = fetched[i];
    if (item.status === "fulfilled") seeded += options.store.ingest(item.value, true, now).seeded;
    else baselineErrors.push(missing[i]);
  }
  const day = kstDay(now);
  // Korea has UTC+9 year-round. Initial deployment may seed sources at any hour.
  if (options.initializeOnly) return { status: "initialized", day, seeded, baselineErrors };
  const hour = now.getUTCHours();
  const lateSchedule = options.allowLate && hour > 8 && hour < 15;
  // Explicit manual runs may start at any hour, including after an earlier scan.
  if (!options.manualRun && hour !== 8 && !lateSchedule) return { status: "outside_window", day, seeded, baselineErrors };
  if (!sources.some(source => options.store.initialized(source))) return { status: "baseline_error", day, seeded, baselineErrors };
  // GitHub workflow concurrency serializes state restoration and delivery.
  // Record every scan separately; existing PDF claims still prevent repeat sends.
  const scanId = options.store.startScan(day, now);
  try {
    const result = await options.scan();
    const status = baselineErrors.length || result.errors || result.uncertain || result.sourceErrors.length || result.coverageWarnings.length ? "partial" : "complete";
    options.store.finishScan(scanId, status, result);
    return { status, day, scanId, seeded, baselineErrors, result };
  } catch {
    options.store.finishScan(scanId, "failed", { error: "수집 작업 실행 실패. 전송 상태를 확인해 주세요." });
    return { status: "failed", day, scanId, seeded, baselineErrors };
  }
}

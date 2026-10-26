import { DeliveryError, sendTelegramDocument } from "./report-bot.ts";
import type { TelegramDocument } from "./report-bot.ts";
import { classifyIndustry, industryCaption, industryFilename, industryKey } from "./industry-filter.ts";
import type { Decision } from "./industry-filter.ts";
import { classifyDomesticIssuer, classifyUsFocus } from "./industry-focus.ts";
import { collectSource, inspectPdf } from "./industry-sources.ts";
import type { IndustryReport, Source, SourceResult } from "./industry-sources.ts";
import { configuredSources } from "./source-config.ts";
import { IndustryStore } from "./industry-store.ts";

export async function processIndustry(reports: IndustryReport[], options: {
  store: IndustryStore; live: boolean;
  inspect?: (r: IndustryReport) => Promise<IndustryReport>;
  classifyAi?: (r: IndustryReport) => Promise<Decision>;
  summarize?: (r: IndustryReport) => Promise<string>;
  sender?: (document: TelegramDocument) => Promise<string>; policy?: string; throttleMs?: number;
  checkpoint?: () => Promise<void>;
}) {
  const result = { checked: 0, eligible: 0, excluded: 0, review: 0, sent: 0, duplicates: 0, errors: 0, uncertain: 0, previews: [] as string[] };
  const seen = new Set<string>();
  const policy = options.policy || "us-industry-labels-v2";
  for (let r of reports) {
    result.checked++;
    let decision = classifyIndustry(r);
    if (decision.status !== "excluded") {
      const issuer = classifyDomesticIssuer(r);
      if (issuer.status !== "eligible") {
        result.review++;
        if (options.live) options.store.save(r, issuer.status, issuer.reason, policy);
        continue;
      }
    }
    if (decision.status !== "excluded") {
      try { r = await (options.inspect || inspectPdf)(r); }
      catch (error) {
        result.errors++;
        if (options.live) options.store.save(r, "error", error instanceof Error ? error.message : "PDF 확인 실패", policy, 10 * 60 * 1000);
        continue;
      }
      decision = classifyIndustry(r);
    }
    if (decision.status === "review" && options.classifyAi) {
      try { decision = await options.classifyAi(r); }
      catch {
        result.errors++;
        if (options.live) options.store.save(r, "error", "AI 판정 실패", policy, 10 * 60 * 1000);
        continue;
      }
    }
    if (decision.status === "eligible") {
      const focus = classifyUsFocus(r);
      decision = focus.status === "eligible"
        ? { status: "eligible", reason: `${focus.reason} / ${decision.reason}` }
        : focus;
    }
    if (decision.status !== "eligible") {
      result[decision.status]++;
      if (options.live) options.store.save(r, decision.status, decision.reason, policy);
      continue;
    }
    result.eligible++;
    if (options.live && !r.pdfBytes?.length) {
      result.errors++;
      options.store.save(r, "error", "PDF_ATTACHMENT: 원문 파일을 확보하지 못했습니다.", policy, 10 * 60 * 1000);
      continue;
    }
    const key = industryKey(r); const hashKey = r.pdfHash ? `pdf:${r.pdfHash}` : key;
    if (seen.has(key) || seen.has(hashKey)) {
      result.duplicates++;
      if (options.live) options.store.save(r, "duplicate", "동일 실행에서 이미 확인한 원문입니다.", policy);
      continue;
    }
    seen.add(key); seen.add(hashKey);
    if (!options.live) {
      result.previews.push(`📎 ${industryFilename(r)}\n${industryCaption(r, decision)}`);
      continue;
    }
    options.store.save(r, "ready", decision.reason, policy);
    const claim = options.store.claim(r);
    if (!claim.acquired) {
      result.duplicates++;
      options.store.save(r, claim.status === "sent" ? "duplicate" : "uncertain", `기존 전송 상태: ${claim.status}`, policy);
      continue;
    }
    let summary = "";
    if (options.summarize) {
      try { summary = await options.summarize(r); } catch { summary = "요약을 만들지 못해 PDF 원문만 첨부합니다."; }
    }
    // Persist a pending delivery remotely before sending from a temporary runner.
    try { await options.checkpoint?.(); }
    catch {
      options.store.mark(claim.id, "failed");
      options.store.save(r, "error", "전송 전 이력 보관에 실패하여 파일을 보내지 않았습니다.", policy, 10 * 60 * 1000);
      result.errors++;
      break;
    }
    try {
      if (result.sent && (options.throttleMs || 0) > 0) await new Promise(resolve => setTimeout(resolve, options.throttleMs));
      const messageId = await (options.sender || sendTelegramDocument)({
        bytes: r.pdfBytes!, filename: industryFilename(r), caption: industryCaption(r, decision, summary),
      });
      options.store.mark(claim.id, "sent", messageId); options.store.save(r, "sent", decision.reason, policy); result.sent++;
    } catch (error) {
      const definitive = error instanceof DeliveryError && error.definitive;
      options.store.mark(claim.id, definitive ? "failed" : "uncertain");
      options.store.save(r, definitive ? "error" : "uncertain", "텔레그램 전송 결과 확인이 필요합니다.", policy, definitive ? 10 * 60 * 1000 : 0);
      if (definitive) result.errors++; else result.uncertain++;
    }
  }
  return result;
}

export async function runIndustryScan(live = false, dependencies: {
  collect?: (source: Source, options: { known: Set<string>; maxPages: number }) => Promise<SourceResult>;
  inspect?: (r: IndustryReport) => Promise<IndustryReport>;
  checkpoint?: () => Promise<void>;
} = {}) {
  if (live && process.env.BOT_SEND_ENABLED !== "true") throw new Error("BOT_SEND_ENABLED=true 설정이 필요합니다.");
  if (live && (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID)) throw new Error("텔레그램 봇 토큰과 본인 채팅 ID가 필요합니다.");
  const sources = configuredSources();
  const maxPages = Number(process.env.INDUSTRY_MAX_PAGES || 10);
  const limit = Number(process.env.INDUSTRY_PREVIEW_LIMIT || 5);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("수집 페이지/처리 개수 설정이 잘못되었습니다.");
  if (live && process.env.AI_CLASSIFY === "true" &&
    (!process.env.AI_GATEWAY_API_KEY || !(process.env.CLASSIFIER_MODEL || process.env.SUMMARY_MODEL))) throw new Error("AI 옵션을 사용하려면 모델과 API 키를 설정해 주세요.");
  if (live && process.env.AI_SUMMARY === "true" && (!process.env.AI_GATEWAY_API_KEY || !process.env.SUMMARY_MODEL)) throw new Error("AI 요약 모델과 API 키를 설정해 주세요.");
  const store = new IndustryStore(live ? (process.env.STATE_PATH || "./data/deliveries.sqlite") : ":memory:");
  try {
    const collected = await Promise.allSettled(sources.map(source => (dependencies.collect || collectSource)(source, { known: store.known(source), maxPages: live ? maxPages : 1 })));
    const successes: SourceResult[] = []; const sourceErrors: { source: string; error: string }[] = [];
    for (let i = 0; i < collected.length; i++) {
      const item = collected[i];
      if (item.status === "fulfilled") successes.push(item.value);
      else sourceErrors.push({ source: sources[i], error: item.reason instanceof Error ? item.reason.message : "수집 실패" });
    }
    if (!successes.length) throw new Error(`모든 수집 경로가 실패했습니다: ${sourceErrors.map(x => `${x.source}: ${x.error}`).join("; ")}`);
    let seeded = 0; let newlyRegistered = 0; const coverageWarnings: string[] = [];
    if (live) for (const source of successes) {
      const alreadyInitialized = store.initialized(source.source);
      const counts = store.ingest(source, true); seeded += counts.seeded; newlyRegistered += counts.added;
      if (source.truncated && alreadyInitialized) coverageWarnings.push(`${source.source}: 이전 확인 지점에 도달하지 못했습니다. 확인 페이지 수를 늘려야 할 수 있습니다.`);
    }
    const aiEnabled = live && process.env.AI_CLASSIFY === "true";
    const policy = aiEnabled ? `us-industry-hybrid-v2:${process.env.CLASSIFIER_MODEL || process.env.SUMMARY_MODEL}` : "us-industry-labels-v2";
    // Snapshot all due work for the one daily delivery window; preview alone is capped.
    const jobs = live ? store.pending(policy, -1, Date.now(), sources) : successes.flatMap(x => x.reports).slice(0, limit);
    const ai = aiEnabled || (live && process.env.AI_SUMMARY === "true") ? await import("./industry-ai.ts") : undefined;
    const result = await processIndustry(jobs, {
      store, live, inspect: dependencies.inspect, policy, throttleMs: live ? 1100 : 0,
      checkpoint: dependencies.checkpoint,
      classifyAi: aiEnabled ? ai!.classifyWithAi : undefined,
      summarize: live && process.env.AI_SUMMARY === "true" ? ai!.summarizeIndustry : undefined,
    });
    return { mode: "us_industry_in_depth", ...result, seeded, newlyRegistered,
      collected: successes.map(x => ({ source: x.source, count: x.reports.length })), sourceErrors, coverageWarnings };
  } finally { store.close(); }
}

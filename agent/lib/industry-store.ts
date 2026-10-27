import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { industryKey } from "./industry-filter.ts";
import type { IndustryReport, Source, SourceResult } from "./industry-sources.ts";
import { configuredSources } from "./source-config.ts";

function reportMetadata(r: IndustryReport) {
  const { coverText: _cover, analysisText: _analysis, pdfBytes: _bytes, ...metadata } = r;
  return metadata;
}

export class IndustryStore {
  db: DatabaseSync;
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS industry_sources(source TEXT PRIMARY KEY, initialized_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS industry_observations(
        source TEXT, source_id TEXT, first_seen TEXT NOT NULL, status TEXT NOT NULL,
        report_json TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', policy TEXT NOT NULL DEFAULT '',
        retry_after INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(source,source_id));
      CREATE TABLE IF NOT EXISTS industry_deliveries(
        id TEXT PRIMARY KEY,status TEXT NOT NULL,pdf_hash TEXT UNIQUE,
        updated TEXT NOT NULL,message_id TEXT,title TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS industry_schedule_runs(
        day TEXT PRIMARY KEY,status TEXT NOT NULL,started_at TEXT NOT NULL,
        finished_at TEXT,result_json TEXT);
      CREATE TABLE IF NOT EXISTS industry_scan_runs(
        id INTEGER PRIMARY KEY AUTOINCREMENT,day TEXT NOT NULL,status TEXT NOT NULL,
        started_at TEXT NOT NULL,finished_at TEXT,result_json TEXT);`);
  }
  known(source: Source): Set<string> {
    return new Set(this.db.prepare("SELECT source_id FROM industry_observations WHERE source=?").all(source).map(x => String(x.source_id)));
  }
  initialized(source: Source): boolean {
    return !!this.db.prepare("SELECT source FROM industry_sources WHERE source=?").get(source);
  }
  ingest(result: SourceResult, seedFirst = true, now = new Date()): { seeded: number; added: number } {
    const seed = seedFirst && !this.initialized(result.source);
    let added = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const statement = this.db.prepare(`INSERT OR IGNORE INTO industry_observations
        (source,source_id,first_seen,status,report_json) VALUES(?,?,?,?,?)`);
      for (const r of result.reports) added += Number(statement.run(r.source, r.sourceId, now.toISOString(), seed ? "seeded" : "new", JSON.stringify(reportMetadata(r))).changes);
      this.db.prepare("INSERT OR IGNORE INTO industry_sources VALUES(?,?)").run(result.source, now.toISOString());
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    return { seeded: seed ? added : 0, added: seed ? 0 : added };
  }
  pending(policy: string, limit = 20, now = Date.now(), sources: Source[] = configuredSources()): IndustryReport[] {
    if (!sources.length) return [];
    const placeholders = sources.map(() => "?").join(",");
    return this.db.prepare(`SELECT report_json FROM industry_observations WHERE
      (status IN ('new','error','ready') OR (status='review' AND policy!=?)) AND retry_after<=?
      AND source IN (${placeholders})
      ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'ready' THEN 1 WHEN 'error' THEN 2 ELSE 3 END,
      first_seen,source,source_id LIMIT ?`).all(policy, now, ...sources, limit).map(x => JSON.parse(String(x.report_json)));
  }
  save(r: IndustryReport, status: string, reason: string, policy = "labels-v1", delayMs = 0) {
    this.db.prepare(`UPDATE industry_observations SET status=?,reason=?,policy=?,report_json=?,retry_after=?
      WHERE source=? AND source_id=?`).run(status, reason.slice(0, 500), policy, JSON.stringify(reportMetadata(r)), delayMs ? Date.now() + delayMs : 0, r.source, r.sourceId);
  }
  claim(r: IndustryReport): { id: string; acquired: boolean; status: string } {
    const id = industryKey(r);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare(`SELECT id,status FROM industry_deliveries
        WHERE id=? OR (pdf_hash IS NOT NULL AND pdf_hash=?) LIMIT 1`).get(id, r.pdfHash || null);
      if (existing && existing.status !== "failed") {
        this.db.exec("COMMIT"); return { id: String(existing.id), acquired: false, status: String(existing.status) };
      }
      if (existing) {
        this.db.prepare("UPDATE industry_deliveries SET status='pending',updated=? WHERE id=?").run(new Date().toISOString(), String(existing.id));
        this.db.exec("COMMIT"); return { id: String(existing.id), acquired: true, status: "pending" };
      }
      this.db.prepare("INSERT INTO industry_deliveries(id,status,pdf_hash,updated,title) VALUES(?,'pending',?,?,?)")
        .run(id, r.pdfHash || null, new Date().toISOString(), r.title);
      this.db.exec("COMMIT"); return { id, acquired: true, status: "pending" };
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  mark(id: string, status: string, messageId = "") {
    this.db.prepare("UPDATE industry_deliveries SET status=?,updated=?,message_id=? WHERE id=?")
      .run(status, new Date().toISOString(), messageId, id);
  }
  startScan(day: string, now = new Date()): number {
    return Number(this.db.prepare("INSERT INTO industry_scan_runs(day,status,started_at) VALUES(?,'running',?)")
      .run(day, now.toISOString()).lastInsertRowid);
  }
  finishScan(id: number, status: "complete" | "partial" | "failed", result: Record<string, unknown>) {
    this.db.prepare("UPDATE industry_scan_runs SET status=?,finished_at=?,result_json=? WHERE id=?")
      .run(status, new Date().toISOString(), JSON.stringify(result), id);
  }
  // Legacy day claims remain readable; current scans no longer use a daily limit.
  claimDay(day: string, now = new Date()): boolean {
    return Number(this.db.prepare("INSERT OR IGNORE INTO industry_schedule_runs(day,status,started_at) VALUES(?,'running',?)")
      .run(day, now.toISOString()).changes) === 1;
  }
  finishDay(day: string, status: "complete" | "partial" | "failed", result: Record<string, unknown>) {
    this.db.prepare("UPDATE industry_schedule_runs SET status=?,finished_at=?,result_json=? WHERE day=?")
      .run(status, new Date().toISOString(), JSON.stringify(result), day);
  }
  status() {
    return {
      sources: this.db.prepare("SELECT * FROM industry_sources").all(),
      observations: this.db.prepare("SELECT status,COUNT(*) AS count FROM industry_observations GROUP BY status").all(),
      deliveries: this.db.prepare("SELECT * FROM industry_deliveries ORDER BY updated DESC LIMIT 50").all(),
      review: this.db.prepare("SELECT source,source_id,reason FROM industry_observations WHERE status='review' LIMIT 50").all(),
      scheduledRuns: this.db.prepare("SELECT day,status,started_at,finished_at FROM industry_schedule_runs ORDER BY day DESC LIMIT 7").all(),
      scanRuns: this.db.prepare("SELECT id,day,status,started_at,finished_at FROM industry_scan_runs ORDER BY id DESC LIMIT 50").all(),
    };
  }
  close() { this.db.close(); }
}

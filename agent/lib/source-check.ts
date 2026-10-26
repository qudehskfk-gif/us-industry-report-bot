import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectSource, inspectPdf } from "./industry-sources.ts";
import { configuredSources, SOURCE_NAMES } from "./source-config.ts";
import { classifyIndustry } from "./industry-filter.ts";
import { classifyUsFocus } from "./industry-focus.ts";

// Read-only preflight: this module has no Telegram sender or live delivery path.
const requested = process.argv.find(a => a.startsWith("--sources="))?.slice(10);
const sources = configuredSources(requested);
const inspect = process.argv.includes("--pdf");
const reportPath = resolve(process.env.SOURCE_CHECK_OUTPUT || "data/source-integration-check.json");
const results = await Promise.allSettled(sources.map(async source => {
  const checkedAt = new Date().toISOString();
  try {
    const result = await collectSource(source, { maxPages: 2 });
    const candidates = result.reports.filter(r => r.category === "산업" && classifyIndustry(r).status !== "excluded");
    const candidate = candidates.find(r => classifyIndustry(r).status === "eligible") ||
      candidates.find(r => /AI|미국|우주|반도체/iu.test(r.title)) || candidates[0];
    let pdf;
    const pdfErrors: { id: string; error: string }[] = [];
    if (inspect && candidate) {
      const attempts = [candidate, ...candidates.filter(r => r.sourceId !== candidate.sourceId)].slice(0, 3);
      for (const item of attempts) {
        try {
          const original = await inspectPdf(item);
          pdf = { id: original.sourceId, title: original.title, pages: original.pages, bytes: original.pdfBytes?.length, sha256: original.pdfHash,
            depth: classifyIndustry(original), usFocus: classifyUsFocus(original) };
          break;
        } catch (error) { pdfErrors.push({ id: item.sourceId, error: error instanceof Error ? error.message : "PDF 확인 실패" }); }
      }
      if (!pdf) throw new Error(`PDF 확인 실패 ${pdfErrors.length}건: ${pdfErrors[0]?.error}`);
    }
    const value = { source, name: SOURCE_NAMES[source], checkedAt, status: "verified", reports: result.reports.length,
      industryReports: result.reports.filter(r => r.category === "산업").length, moreHistory: result.truncated, ...(pdf ? { pdf } : {}), ...(pdfErrors.length ? { pdfErrors } : {}) };
    console.log(JSON.stringify(value)); return value;
  } catch (error) {
    const value = { source, name: SOURCE_NAMES[source], checkedAt, status: "failed", error: error instanceof Error ? error.message : "수집 검증 실패" };
    console.log(JSON.stringify(value)); return value;
  }
}));
const values = results.map((r, i) => r.status === "fulfilled" ? r.value : ({ source: sources[i], status: "failed", error: "검증 실패" }));
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify({ checkedAt: new Date().toISOString(), telegramSent: false, results: values }, null, 2));
if (values.some(r => r.status !== "verified")) process.exitCode = 1;

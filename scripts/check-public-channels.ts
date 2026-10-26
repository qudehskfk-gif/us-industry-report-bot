import { collectSource, inspectPdf } from "../agent/lib/industry-sources.ts";
import { PUBLIC_CHANNELS, type ChannelSource } from "../agent/lib/public-channels.ts";
import { classifyIndustry } from "../agent/lib/industry-filter.ts";
import { classifyUsFocus } from "../agent/lib/industry-focus.ts";
import { publicError } from "../agent/lib/public-http.ts";
import { mkdir, writeFile } from "node:fs/promises";

// Retrieval proof only: no Telegram sender, bot token, or chat ID is used.
const sources = Object.keys(PUBLIC_CHANNELS) as ChannelSource[];
const results: Record<string, unknown>[] = [];
for (let index = 0; index < sources.length; index += 2) {
  const batch = await Promise.all(sources.slice(index, index + 2).map(async source => {
    try {
      const list = await collectSource(source, { maxPages: 2 });
      const priority = [...list.reports].sort((a, b) => {
        const score = (r: typeof a) => classifyIndustry(r).status === "eligible" ? 0 : r.category === "산업" && /인[\s·-]*뎁스|\bin[ -]*depth\b|심층/iu.test(r.excerpt || "") ? 1 : r.category === "산업" && classifyIndustry(r).status !== "excluded" ? 2 : 3;
        return score(a) - score(b) || b.published.localeCompare(a.published);
      });
      let pdf: Record<string, unknown> | undefined;
      const errors: { id: string; error: string }[] = [];
      for (const candidate of priority.slice(0, 4)) {
        try {
          const original = await inspectPdf(candidate);
          pdf = { id: original.sourceId, title: original.title, broker: original.broker, sourceUrl: original.sourceUrl,
            pdfUrl: original.pdfUrl, pages: original.pages, bytes: original.pdfBytes!.length, sha256: original.pdfHash,
            depth: classifyIndustry(original), usFocus: classifyUsFocus(original) };
          break;
        } catch (error) { errors.push({ id: candidate.sourceId, error: publicError(error) }); }
      }
      return { source, broker: PUBLIC_CHANNELS[source].broker, status: pdf ? "verified" : "pdf_unverified",
        reports: list.reports.length, industryReports: list.reports.filter(r => r.category === "산업").length,
        ...(pdf ? { pdf } : {}), errors, moreHistory: list.truncated };
    } catch (error) { return { source, status: "failed", error: publicError(error) }; }
  }));
  for (const item of batch) { results.push(item); console.log(JSON.stringify({ event: "public_channel_check", ...item })); }
}
await mkdir("data", { recursive: true });
await writeFile("data/public-channel-check.json", JSON.stringify({ checkedAt: new Date().toISOString(), telegramSent: false, results }, null, 2));

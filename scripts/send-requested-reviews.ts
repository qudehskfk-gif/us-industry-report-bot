import { IndustryStore } from "../agent/lib/industry-store.ts";
import { saveGithubState } from "../agent/lib/github-state.ts";
import { REQUESTED_REVIEW_BATCH, sendRequestedReviewBatch } from "../agent/lib/requested-review-batch.ts";

try {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      process.env.BOT_SEND_ENABLED !== "true" || process.env.APPROVED_REVIEW_BATCH !== REQUESTED_REVIEW_BATCH) {
    throw new Error("이번에 승인된 22개 게시물의 수동 발송에만 사용할 수 있습니다.");
  }
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID || !process.env.STATE_PATH) {
    throw new Error("기존 봇의 발송 연결과 상태 이력이 필요합니다.");
  }
  const store = new IndustryStore(process.env.STATE_PATH);
  try {
    const result = await sendRequestedReviewBatch({
      store, approvedBatch: process.env.APPROVED_REVIEW_BATCH,
      checkpoint: async () => { saveGithubState(); },
      pause: () => new Promise(resolve => setTimeout(resolve, 1100)),
    });
    console.log(JSON.stringify({ event: "requested_review_batch", ...result }));
    if (result.errors.length || result.uncertain.length) process.exitCode = 1;
  } finally { store.close(); }
} catch (error) {
  console.error(error instanceof Error ? error.message : "요청 자료 발송 실패");
  process.exitCode = 1;
}


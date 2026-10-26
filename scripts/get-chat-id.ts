export {};
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.error("TELEGRAM_BOT_TOKEN을 .env에 입력해 주세요."); process.exit(1); }
try {
  const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({ timeout: 0, limit: 100, allowed_updates: ["message"] }),
    cache: "no-store", signal: AbortSignal.timeout(15000),
  });
  const body = await response.json() as { ok?: boolean; error_code?: number; result?: Array<{ message?: { chat?: { id: number; type: string } } }> };
  if (!body.ok) throw new Error(`TELEGRAM_REJECTED: ${body.error_code || response.status}`);
  const ids = [...new Set((body.result || []).filter((u) => u.message?.chat?.type === "private").map((u) => u.message!.chat!.id))];
  console.log(JSON.stringify({ private_chat_ids: ids, hint: ids.length ? "본인의 ID를 TELEGRAM_CHAT_ID에 입력하세요." : "새 봇과의 개인 대화에서 /start를 보낸 뒤 다시 실행하세요." }, null, 2));
} catch {
  console.error("채팅 ID 조회 실패. 네트워크와 봇 설정을 확인해 주세요."); process.exitCode = 1;
}

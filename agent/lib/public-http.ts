// Bounded retries apply only to public, read-only report retrieval. Never use
// this helper for Telegram sends or another operation with an external effect.
const transient = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);

export function publicError(error: unknown): string {
  if (!(error instanceof Error)) return "공개 자료 요청 실패";
  const cause = error.cause as { code?: string } | undefined;
  return `${error.message}${cause?.code ? ` (${cause.code})` : ""}`;
}

export async function fetchPublicResource(address: string, init: RequestInit = {}, options: {
  fetcher?: typeof fetch; timeoutMs?: number; retrySafe?: boolean;
} = {}): Promise<Response> {
  const safe = /^(?:GET|HEAD)$/u.test(init.method || "GET") || options.retrySafe === true;
  const attempts = safe ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await (options.fetcher || fetch)(address, {
        ...init, signal: AbortSignal.timeout(options.timeoutMs || 25000),
      });
      if (attempt + 1 < attempts && [502, 503, 504].includes(response.status)) {
        await response.body?.cancel();
        await new Promise(resolve => setTimeout(resolve, 250));
        continue;
      }
      return response;
    } catch (error) {
      const cause = error instanceof Error ? error.cause as { code?: string } | undefined : undefined;
      const retry = cause?.code && transient.has(cause.code) || error instanceof Error && /^(?:TimeoutError|AbortError)$/u.test(error.name);
      if (attempt + 1 >= attempts || !retry) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error("공개 자료 요청 실패");
}

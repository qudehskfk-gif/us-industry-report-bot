// Only bounded read-only retrieval retries. Never use for Telegram sends.
const transient = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
type PublicOptions = { fetcher?: typeof fetch; timeoutMs?: number; retrySafe?: boolean };
export function publicError(error: unknown): string {
  if (!(error instanceof Error)) return '공개 자료 요청 실패';
  const cause = error.cause as { code?: string } | undefined;
  return `${error.message}${cause?.code ? ` (${cause.code})` : ''}`;
}
async function publicRequest<T>(address: string, init: RequestInit, options: PublicOptions, consume: (response: Response) => Promise<T>): Promise<T> {
  const safe = /^(?:GET|HEAD)$/u.test(init.method || 'GET') || options.retrySafe === true;
  const attempts = safe ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await (options.fetcher || fetch)(address, { ...init, signal: AbortSignal.timeout(options.timeoutMs || 25000) });
      if (attempt + 1 < attempts && [502, 503, 504].includes(response.status)) {
        await response.body?.cancel();
        await new Promise(resolve => setTimeout(resolve, 250));
        continue;
      }
      return await consume(response);
    } catch (error) {
      const cause = error instanceof Error ? error.cause as { code?: string } | undefined : undefined;
      const retry = cause?.code && transient.has(cause.code) || error instanceof Error && /^(?:TimeoutError|AbortError)$/u.test(error.name);
      if (attempt + 1 >= attempts || !retry) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error('공개 자료 요청 실패');
}
export function fetchPublicResource(address: string, init: RequestInit = {}, options: PublicOptions = {}): Promise<Response> {
  return publicRequest(address, init, options, async response => response);
}
// The complete body is inside the same two-attempt budget as the headers.
// Discard every incomplete attempt; never concatenate partial PDF downloads.
export function readPublicBytes(address: string, init: RequestInit, options: PublicOptions & { maxBytes: number; sizeError: string }): Promise<{ response: Response; bytes: Buffer }> {
  return publicRequest(address, init, options, async response => {
    if (!response.ok || !response.body) return { response, bytes: Buffer.alloc(0) };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.length;
        if (size > options.maxBytes) throw new Error(options.sizeError);
        chunks.push(part.value);
      }
      return { response, bytes: Buffer.concat(chunks) };
    } finally { await reader.cancel().catch(() => {}); }
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readPublicBytes } from '../agent/lib/public-http.ts';
const options = { maxBytes: 100, sizeError: 'PDF_SIZE' };
test('본문 중단 후 처음부터 다시 받아 불완전한 PDF 조각을 버립니다', async () => {
  let calls = 0;
  const result = await readPublicBytes('https://example.test/report.pdf', {}, { ...options, fetcher: async () => {
    calls++;
    if (calls === 1) return new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('%PDF-incomplete')); },
      pull(c) { c.error(new TypeError('terminated', { cause: Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' }) })); },
    }));
    return new Response('%PDF-complete');
  } });
  assert.equal(calls, 2); assert.equal(result.bytes.toString(), '%PDF-complete');
});
test('연결 거절은 한번 재시도하고 크기 초과·접근 거절은 재시도하지 않습니다', async () => {
  let calls = 0;
  await readPublicBytes('https://example.test/', {}, { ...options, fetcher: async () => {
    if (++calls === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
    return new Response('ok');
  } }); assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(readPublicBytes('https://example.test/', {}, { ...options, fetcher: async () => { calls++; return new Response('x'.repeat(101)); } }), /PDF_SIZE/);
  assert.equal(calls, 1);
  calls = 0;
  const denied = await readPublicBytes('https://example.test/', {}, { ...options, fetcher: async () => { calls++; return new Response('denied', { status: 403 }); } });
  assert.equal(calls, 1); assert.equal(denied.response.status, 403); assert.equal(denied.bytes.length, 0);
});
test('헤더 오류와 본문 오류가 이어져도 전체 요청은 최대 두 번입니다', async () => {
  let calls = 0;
  await assert.rejects(readPublicBytes('https://example.test/', {}, { ...options, fetcher: async () => {
    if (++calls === 1) return new Response(null, { status: 503 });
    return new Response(new ReadableStream({ start(c) { c.error(new TypeError('terminated', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) })); } }));
  } })); assert.equal(calls, 2);
});

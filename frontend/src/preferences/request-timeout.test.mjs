import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchJson, RequestTimeoutError } from '../fetch-json.ts';

test('request timeout also aborts a stalled response body', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => ({
    status: 200, ok: true,
    json: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  }));
  await assert.rejects(fetchJson('/synthetic', {}, 5), RequestTimeoutError);
});

test('a truncated successful response remains an unknown result', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{"version":', { status: 200 }));
  await assert.rejects(fetchJson('/synthetic', {}), SyntaxError);
});

test('non-JSON error pages preserve HTTP status and release the timer', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('Gateway unavailable', { status: 503 }));
  const { response, data } = await fetchJson('/synthetic', {});
  assert.equal(response.status, 503);
  assert.equal(data, null);
});

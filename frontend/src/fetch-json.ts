export const REQUEST_TIMEOUT_MS = 20_000;
export class RequestTimeoutError extends Error {}

// 超时覆盖响应正文，避免仅收到响应头后仍无限等待；写请求由调用者保留原操作键。
export async function fetchJson(url: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (response.status === 204) return { response, data: undefined };
    let data;
    try { data = await response.json(); }
    catch (reason) { if (response.ok || controller.signal.aborted) throw reason; data = null; }
    return { response, data };
  } catch (reason) {
    if (controller.signal.aborted) throw new RequestTimeoutError('Request timed out');
    throw reason;
  } finally { clearTimeout(timeout); }
}

import { fetchJson, RequestTimeoutError } from './fetch-json';

export class ApiError extends Error {
  constructor(message: string, public status: number, public retryAfter?: number) { super(message); }
}

function errorText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(errorText).join('；');
  if (value && typeof value === 'object') return Object.values(value).map(errorText).join('；');
  return '请求未能完成，请稍后重试。';
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let response: Response, data;
  const csrf = document.cookie.split('; ').find(value => value.startsWith('csrftoken='))?.slice(10);
  try {
    ({ response, data } = await fetchJson(`/api/${path}`, {
      method, credentials: 'same-origin',
      headers: { 'Accept': 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(csrf && method !== 'GET' ? { 'X-CSRFToken': decodeURIComponent(csrf) } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    }));
  } catch (reason) { throw new ApiError(reason instanceof RequestTimeoutError ? '请求超时，请重试。' : '连接暂时中断，请检查网络后重试。', 0); }
  if (!response.ok) throw new ApiError(data ? errorText(data) : '服务暂时不可用，请稍后重试。', response.status, /^\d+$/.test(response.headers.get('Retry-After') || '') ? Number(response.headers.get('Retry-After')) : undefined);
  return data as T;
}

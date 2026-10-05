// Blockscout 같은 공개 API용 GET.
//
// Blockscout 익명 한도는 IP당 분당 300회이고, 넘기면 수십 초 동안 전부 429가 된다.
// 429는 x-ratelimit-reset(밀리초)만큼 기다렸다가 재시도 횟수와 상관없이 다시 시도하고,
// 요청 사이에 최소 간격(기본 400ms, 분당 150회)을 둔다.
// 5xx·Cloudflare 524·타임아웃은 지수 백오프로 재시도한다.

export class HttpError extends Error {
  status: number;
  constructor(url: string, status: number) {
    super(`${url}: HTTP ${status}`);
    this.status = status;
  }
}

const MIN_INTERVAL_MS = Number(process.env.PROOFGAP_MIN_INTERVAL_MS ?? 400);
const MAX_RATE_LIMIT_WAIT_MS = 15 * 60_000;
let nextSlot = 0;

async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = nextSlot - now;
  nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL_MS;
  if (wait > 0) await sleep(wait);
}

export async function getJson<T>(url: string, opts: { retries?: number; timeoutMs?: number } = {}): Promise<T> {
  const retries = opts.retries ?? 4;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let lastError: unknown;
  let attempt = 0;
  let rateLimitedMs = 0;
  while (attempt <= retries) {
    await throttle();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return (await res.json()) as T;
      lastError = new HttpError(url, res.status);
      if (res.status === 429 && rateLimitedMs < MAX_RATE_LIMIT_WAIT_MS) {
        const reset = Number(res.headers.get("x-ratelimit-reset")) || 30_000;
        const wait = Math.min(reset, 120_000) + 1000;
        rateLimitedMs += wait;
        nextSlot = Date.now() + wait;
        continue;
      }
      if (res.status !== 429 && res.status < 500) break;
    } catch (e) {
      lastError = e;
    }
    attempt++;
    if (attempt <= retries) await sleep(1000 * 2 ** attempt);
  }
  throw lastError;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 동시에 최대 n개만 실행한다.
export async function mapLimit<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

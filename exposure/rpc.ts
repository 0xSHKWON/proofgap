// 읽기 전용 JSON-RPC. 트랜잭션을 보내는 메서드는 일부러 만들지 않는다.

import type { Chain } from "../scanner/fetch.ts";
import { sleep } from "../scanner/http.ts";

const RPC_URLS: Record<Chain, string> = {
  ethereum: process.env.ETHEREUM_RPC_URL ?? "https://ethereum-rpc.publicnode.com",
  base: process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
};

type ReadMethod = "eth_call" | "eth_getCode" | "eth_getStorageAt" | "eth_getBalance" | "eth_blockNumber";

async function rpc<T>(chain: Chain, method: ReadMethod, params: unknown[]): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** attempt);
    try {
      const res = await fetch(RPC_URLS[chain], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        lastError = new Error(`${method}: HTTP ${res.status}`);
        continue;
      }
      const j = (await res.json()) as { result?: T; error?: { message: string } };
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result as T;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

// 여러 슬롯을 JSON-RPC 배치 요청으로 읽는다. Base 공개 RPC는 배치당 최대 10건이라 8건씩 나눈다.
const BATCH_SIZE = 8;

export async function getStorageSlots(chain: Chain, address: string, slots: string[]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < slots.length; i += BATCH_SIZE) {
    out.push(...(await storageBatch(chain, address, slots.slice(i, i + BATCH_SIZE))));
  }
  return out;
}

async function storageBatch(chain: Chain, address: string, slots: string[]): Promise<string[]> {
  const body = slots.map((slot, id) => ({ jsonrpc: "2.0", id, method: "eth_getStorageAt", params: [address, slot, "latest"] }));
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** attempt);
    try {
      const res = await fetch(RPC_URLS[chain], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        lastError = new Error(`eth_getStorageAt batch: HTTP ${res.status}`);
        continue;
      }
      const out = (await res.json()) as { id: number; result?: string; error?: { message: string } }[];
      if (!Array.isArray(out)) throw new Error(`배치 응답이 배열이 아님: ${JSON.stringify(out).slice(0, 200)}`);
      return slots.map((_, id) => out.find((o) => o.id === id)?.result ?? "0x");
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

export const getCode = (chain: Chain, address: string) => rpc<string>(chain, "eth_getCode", [address, "latest"]);
export const getStorageAt = (chain: Chain, address: string, slot: string) =>
  rpc<string>(chain, "eth_getStorageAt", [address, slot, "latest"]);
export const blockNumber = async (chain: Chain) => Number(await rpc<string>(chain, "eth_blockNumber", []));

// 인자 없는 view 함수 호출. 함수가 없거나 되돌리면 null.
export async function callView(chain: Chain, address: string, selector: string): Promise<string | null> {
  try {
    const out = await rpc<string>(chain, "eth_call", [{ to: address, data: selector }, "latest"]);
    return out && out !== "0x" ? out : null;
  } catch {
    return null;
  }
}

export const wordToAddress = (word: string | null): string | null => {
  if (!word || word.length < 66) return null;
  const addr = `0x${word.slice(-40)}`.toLowerCase();
  return /^0x0{40}$/.test(addr) ? null : addr;
};

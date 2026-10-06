// 잔고 스냅샷. Blockscout의 네이티브 잔고와 토큰 잔고, 시세(exchange_rate)를 쓴다.
// 시세가 없는 토큰은 가치를 매기지 않고 개수만 센다 (대부분 스팸 에어드롭).

import { type Chain, CHAINS } from "../scanner/fetch.ts";
import { getJson } from "../scanner/http.ts";

export type AssetLevel = "있음" | "미미" | "없음";

// 이 금액 이상이면 비공개 제보 대상, 1달러 미만은 없음으로 본다.
export const MATERIAL_USD = 100;
const DUST_USD = 1;

export type Snapshot = {
  nativeUsd: number;
  tokens: { symbol: string; address: string; amount: number; usd: number }[]; // 시세 있는 토큰만
  unpricedTokens: number;
  totalUsd: number;
  level: AssetLevel;
  takenAt: string;
};

type TokenBalance = {
  value: string;
  token: { address_hash: string; symbol: string | null; decimals: string | null; exchange_rate: string | null; type: string; reputation?: string };
};

const coinPrice = new Map<Chain, number>();

export async function snapshot(chain: Chain, address: string): Promise<Snapshot> {
  const api = `${CHAINS[chain].blockscout}/api/v2`;
  if (!coinPrice.has(chain)) {
    const stats = await getJson<{ coin_price: string | null }>(`${api}/stats`);
    coinPrice.set(chain, Number(stats.coin_price ?? 0));
  }
  const info = await getJson<{ coin_balance: string | null }>(`${api}/addresses/${address}`);
  const nativeUsd = (Number(BigInt(info.coin_balance ?? "0")) / 1e18) * (coinPrice.get(chain) ?? 0);

  const balances = await getJson<TokenBalance[]>(`${api}/addresses/${address}/token-balances`);
  const tokens: Snapshot["tokens"] = [];
  let unpricedTokens = 0;
  for (const b of balances) {
    if (b.token.type !== "ERC-20") continue;
    const rate = Number(b.token.exchange_rate);
    if (!rate || b.token.reputation === "scam") {
      unpricedTokens++;
      continue;
    }
    const amount = Number(BigInt(b.value)) / 10 ** Number(b.token.decimals ?? 18);
    tokens.push({ symbol: b.token.symbol ?? "?", address: b.token.address_hash.toLowerCase(), amount, usd: amount * rate });
  }
  tokens.sort((a, b) => b.usd - a.usd);
  const totalUsd = nativeUsd + tokens.reduce((s, t) => s + t.usd, 0);
  const level: AssetLevel = totalUsd >= MATERIAL_USD ? "있음" : totalUsd >= DUST_USD ? "미미" : "없음";
  return { nativeUsd, tokens, unpricedTokens, totalUsd, level, takenAt: new Date().toISOString() };
}

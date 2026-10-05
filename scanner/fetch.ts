// 검증된 소스 수집. 지금은 Blockscout v2 API만 쓴다 (키가 필요 없음).

import type { SourceFile } from "./source.ts";

export const CHAINS = {
  ethereum: { chainId: 1, blockscout: "https://eth.blockscout.com" },
  base: { chainId: 8453, blockscout: "https://base.blockscout.com" },
} as const;

export type Chain = keyof typeof CHAINS;

export type VerifiedSource = {
  chain: Chain;
  address: string;
  name: string;
  compilerVersion: string;
  // false면 이 주소가 아니라 바이트코드가 같은 다른 주소(twin)의 소스다.
  verifiedAtAddress: boolean;
  verifiedTwin: string | null;
  files: SourceFile[];
};

export function isChain(value: string): value is Chain {
  return Object.hasOwn(CHAINS, value);
}

export async function fetchVerifiedSource(chain: Chain, address: string): Promise<VerifiedSource> {
  const url = `${CHAINS[chain].blockscout}/api/v2/smart-contracts/${address}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const j = (await res.json()) as {
    name?: string;
    compiler_version?: string;
    is_verified?: boolean;
    verified_twin_address_hash?: string | null;
    file_path?: string;
    source_code?: string;
    additional_sources?: { file_path: string; source_code: string }[];
  };
  if (!j.source_code) throw new Error(`${chain}:${address}: 검증된 소스가 없음`);
  return {
    chain,
    address: address.toLowerCase(),
    name: j.name ?? "",
    compilerVersion: j.compiler_version ?? "",
    verifiedAtAddress: j.is_verified === true,
    verifiedTwin: j.verified_twin_address_hash ?? null,
    files: [
      { path: j.file_path || `${j.name}.sol`, content: j.source_code },
      ...(j.additional_sources ?? []).map((s) => ({ path: s.file_path, content: s.source_code })),
    ],
  };
}

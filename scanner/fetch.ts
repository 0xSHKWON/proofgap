// 검증된 소스 수집. Blockscout v2 API를 먼저 보고, 소스가 없으면 Sourcify를 본다 (둘 다 키가 필요 없음).
// 이더리움 표본에서 Blockscout 미검증 40개 중 7개가 Sourcify에는 있었다.

import { getJson, HttpError } from "./http.ts";
import type { SourceFile } from "./source.ts";

// bigquery: 바이트코드가 들어 있는 contracts 테이블. Polygon은 2024-09 이후 갱신이 멈춰 그 뒤 배포분은 없다.
// Arbitrum·Optimism·Polygon의 goog_blockchain 데이터셋은 contracts 테이블이 없고, 생성 트랜잭션 input을
// 검색하면 1.4~11.6 TB라 무료 한도(월 1 TB)를 넘는다 (L32).
export const CHAINS = {
  ethereum: { chainId: 1, blockscout: "https://eth.blockscout.com", bigquery: "bigquery-public-data.crypto_ethereum.contracts" },
  base: { chainId: 8453, blockscout: "https://base.blockscout.com", bigquery: null },
  arbitrum: { chainId: 42161, blockscout: "https://arbitrum.blockscout.com", bigquery: null },
  optimism: { chainId: 10, blockscout: "https://explorer.optimism.io", bigquery: null },
  polygon: { chainId: 137, blockscout: "https://polygon.blockscout.com", bigquery: "bigquery-public-data.crypto_polygon.contracts" },
} as const;

export type Chain = keyof typeof CHAINS;

export type VerifiedSource = {
  chain: Chain;
  address: string;
  origin?: "blockscout" | "sourcify";
  name: string;
  compilerVersion: string;
  // false면 이 주소가 아니라 바이트코드가 같은 다른 주소(twin)의 소스다.
  verifiedAtAddress: boolean;
  verifiedTwin: string | null;
  files: SourceFile[];
};

export type ContractInfo = {
  source: VerifiedSource | null; // null이면 소스 미검증
  // 프록시면 구현 컨트랙트 주소. 검증키는 구현 쪽 코드에 있다.
  implementations: string[];
  // 배포된 바이트코드에 G2 생성원 좌표(x 허수부)가 나온 횟수. 소스가 없어도 쓸 수 있는 신호다.
  // 정상 snarkjs 검증기는 보통 1(γ), Phase 2를 건너뛰면 2 이상(γ와 δ). 판정이 아니라 우선순위용.
  g2GenCount: number | null;
};

const G2_GEN_X_IM_HEX = "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2";

export function countG2Generator(bytecode: string): number {
  return bytecode.toLowerCase().split(G2_GEN_X_IM_HEX).length - 1;
}

export function isChain(value: string): value is Chain {
  return Object.hasOwn(CHAINS, value);
}

type SmartContractResponse = {
  name?: string;
  compiler_version?: string;
  is_verified?: boolean;
  verified_twin_address_hash?: string | null;
  file_path?: string;
  source_code?: string;
  additional_sources?: { file_path: string; source_code: string }[];
  implementations?: { address_hash: string }[];
  deployed_bytecode?: string | null;
};

export async function fetchContract(chain: Chain, address: string): Promise<ContractInfo> {
  let j: SmartContractResponse;
  try {
    j = await getJson<SmartContractResponse>(`${CHAINS[chain].blockscout}/api/v2/smart-contracts/${address}`);
  } catch (e) {
    // Blockscout가 인덱싱하지 않은 주소는 404다. Sourcify에는 있을 수 있다.
    if (!(e instanceof HttpError && e.status === 404)) throw e;
    return { source: await fetchSourcify(chain, address), implementations: [], g2GenCount: null };
  }
  const implementations = (j.implementations ?? []).map((i) => i.address_hash.toLowerCase());
  const g2GenCount = j.deployed_bytecode ? countG2Generator(j.deployed_bytecode) : null;
  if (!j.source_code) return { source: await fetchSourcify(chain, address), implementations, g2GenCount };
  return {
    source: {
      chain,
      address: address.toLowerCase(),
      origin: "blockscout",
      name: j.name ?? "",
      compilerVersion: j.compiler_version ?? "",
      verifiedAtAddress: j.is_verified === true,
      verifiedTwin: j.verified_twin_address_hash ?? null,
      files: [
        { path: j.file_path || `${j.name}.sol`, content: j.source_code },
        ...(j.additional_sources ?? []).map((s) => ({ path: s.file_path, content: s.source_code })),
      ],
    },
    implementations,
    g2GenCount,
  };
}

type SourcifyResponse = {
  match?: string | null;
  compilation?: { name?: string; compilerVersion?: string };
  sources?: Record<string, { content: string }>;
};

async function fetchSourcify(chain: Chain, address: string): Promise<VerifiedSource | null> {
  const url = `https://sourcify.dev/server/v2/contract/${CHAINS[chain].chainId}/${address}?fields=sources,compilation`;
  let j: SourcifyResponse;
  try {
    j = await getJson<SourcifyResponse>(url);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
  if (!j.sources) return null;
  return {
    chain,
    address: address.toLowerCase(),
    origin: "sourcify",
    name: j.compilation?.name ?? "",
    compilerVersion: j.compilation?.compilerVersion ?? "",
    verifiedAtAddress: true,
    verifiedTwin: null,
    files: Object.entries(j.sources).map(([path, { content }]) => ({ path, content })),
  };
}

export async function fetchVerifiedSource(chain: Chain, address: string): Promise<VerifiedSource> {
  const { source } = await fetchContract(chain, address);
  if (!source) throw new Error(`${chain}:${address}: 검증된 소스가 없음`);
  return source;
}

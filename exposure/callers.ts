// 검증기를 믿는 컨트랙트(호출자) 찾기.
//
//   internal-tx  검증기로 들어온 내부 호출의 from. 실제로 검증기를 부른 적이 있는 컨트랙트다.
//   deployer     검증기 배포자가 만든 다른 컨트랙트 중, 검증기 주소를 참조하는 것.
//                아직 출금이 없어 검증기를 부른 적 없는 풀을 잡기 위한 경로다.
//   bytecode-ref 이더리움 전체 바이트코드에서 검증기 주소를 immutable로 가진 컨트랙트 (exposure refs, BigQuery).
//
// deployer 경로는 참조를 확인해야 후보가 된다: 바이트코드(immutable)나 앞쪽 스토리지 슬롯에
// 검증기 주소가 있거나, verifier() 게터가 검증기 주소를 돌려줘야 한다.

import { type Chain, CHAINS } from "../scanner/fetch.ts";
import { getJson, mapLimit } from "../scanner/http.ts";
import { callView, getCode, getStorageSlots, wordToAddress } from "./rpc.ts";

export type Caller = {
  address: string;
  name: string | null;
  via: ("internal-tx" | "deployer" | "bytecode-ref")[];
  calls: number; // 확인한 페이지 안에서 검증기를 부른 횟수
  reference?: string; // deployer 경로에서 참조를 확인한 방법
};

type PageParams = Record<string, string | number>;
type Page<T> = { items: T[]; next_page_params: PageParams | null };
type Ref = { hash: string; name: string | null; is_contract?: boolean | null };

const MAX_PAGES = 20;
// 주소별 내부 트랜잭션 목록은 Blockscout에서 페이지당 40~60초가 걸린다. 앞쪽만 보고 나머지는 배포자 경로로 보완한다.
const INTERNAL_TX_PAGES = 4;
const CALL_TYPES = new Set(["call", "staticcall", "delegatecall"]);
const STORAGE_SLOTS = 16;
const VERIFIER_GETTER = "0x2b7ac3f3"; // verifier()

async function* pages<T>(url: string, maxPages = MAX_PAGES): AsyncGenerator<T[]> {
  let params: PageParams | null = null;
  for (let i = 0; i < maxPages; i++) {
    const qs = params ? `${url.includes("?") ? "&" : "?"}${new URLSearchParams(params as Record<string, string>)}` : "";
    const page: Page<T> = await getJson<Page<T>>(`${url}${qs}`, { timeoutMs: 110_000 });
    yield page.items;
    params = page.next_page_params;
    if (!params) return;
  }
}

export async function findCallers(
  chain: Chain,
  verifier: string,
  bytecodeRefs: string[] = [],
): Promise<{ callers: Caller[]; truncated: boolean; internalTxError: string | null }> {
  const api = `${CHAINS[chain].blockscout}/api/v2`;
  const v = verifier.toLowerCase();
  const callers = new Map<string, Caller>();
  const add = (ref: Ref, via: Caller["via"][number], extra: Partial<Caller> = {}) => {
    const key = ref.hash.toLowerCase();
    const c = callers.get(key) ?? { address: key, name: ref.name, via: [], calls: 0 };
    if (!c.via.includes(via)) c.via.push(via);
    Object.assign(c, extra);
    callers.set(key, c);
    return c;
  };

  // 1) 검증기로 들어온 내부 호출
  let truncated = false;
  let pageCount = 0;
  // 이더리움 Blockscout는 일부 주소에서 첫 페이지부터 110초 넘게 걸린다. 실패해도 다른 경로로 계속 간다.
  let internalTxError: string | null = null;
  const internalTxUrl = `${api}/addresses/${verifier}/internal-transactions?filter=to`;
  try {
    for await (const items of pages<{ from: Ref; to: Ref | null; type: string }>(internalTxUrl, INTERNAL_TX_PAGES)) {
      pageCount++;
      for (const it of items) {
        // 검증기를 배포한 create 기록(from = 배포자 EOA)은 호출자가 아니다.
        if (!CALL_TYPES.has(it.type) || it.from.is_contract === false) continue;
        if (it.to?.hash.toLowerCase() !== v || it.from.hash.toLowerCase() === v) continue;
        add(it.from, "internal-tx").calls++;
      }
    }
  } catch (e) {
    internalTxError = (e as Error).message;
  }
  if (pageCount === INTERNAL_TX_PAGES || internalTxError) truncated = true;

  // 2) 배포자가 만든 컨트랙트 중 검증기를 참조하는 것
  const info = await getJson<{ creator_address_hash?: string | null }>(`${api}/addresses/${verifier}`);
  const deployer = info.creator_address_hash;
  if (deployer) {
    const created = await memo(`${chain}:created:${deployer}`, async () => {
      const out: Ref[] = [];
      for await (const items of pages<{ created_contract: Ref | null }>(`${api}/addresses/${deployer}/transactions`)) {
        for (const it of items) if (it.created_contract) out.push(it.created_contract);
      }
      return out;
    });
    const others = created.filter((ref) => ref.hash.toLowerCase() !== v);
    const refs = await mapLimit(others, 6, async (ref) => referencesVerifier(await contractState(chain, ref.hash), v));
    others.forEach((ref, i) => {
      const how = refs[i];
      if (how) add(ref, "deployer", { reference: how });
    });
  }

  // 3) 바이트코드 참조 (미리 BigQuery로 찾아 둔 것)
  for (const address of bytecodeRefs) add({ hash: address, name: null }, "bytecode-ref", { reference: "바이트코드(immutable)" });

  return { callers: [...callers.values()], truncated, internalTxError };
}

// 같은 배포자가 검증기 여러 개를 만든 경우(Foom은 체인마다 10개)가 많아서,
// 배포자의 생성 목록과 컨트랙트 상태는 한 번 실행하는 동안 재사용한다.
const cache = new Map<string, Promise<unknown>>();
function memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (!cache.has(key)) cache.set(key, fn().catch((e) => (cache.delete(key), Promise.reject(e))));
  return cache.get(key) as Promise<T>;
}

type ContractState = { code: string; verifierGetter: string | null; storage: string[] };

const contractState = (chain: Chain, contract: string) =>
  memo<ContractState>(`${chain}:state:${contract.toLowerCase()}`, async () => {
    const code = (await getCode(chain, contract)).toLowerCase();
    if (code === "0x") return { code, verifierGetter: null, storage: [] };
    const slots = Array.from({ length: STORAGE_SLOTS }, (_, i) => `0x${i.toString(16)}`);
    return {
      code,
      verifierGetter: wordToAddress(await callView(chain, contract, VERIFIER_GETTER)),
      storage: (await getStorageSlots(chain, contract, slots)).map((w) => w.toLowerCase()),
    };
  });

function referencesVerifier(state: ContractState, verifier: string): string | null {
  const needle = verifier.slice(2);
  if (state.code === "0x") return null;
  if (state.code.includes(needle)) return "바이트코드(immutable)";
  if (state.verifierGetter === verifier) return "verifier() 게터";
  const hit = state.storage.findIndex((w) => w.includes(needle));
  return hit === -1 ? null : `스토리지 슬롯 ${hit}`;
}

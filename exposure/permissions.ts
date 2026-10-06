// 권한 확인: 프록시인지(업그레이드 가능), 정지할 수 있는지, 누가 소유자인지.
// 제보할 때 "운영자가 지금 막을 수 있는가"를 판단하는 근거가 된다.

import { type Chain, CHAINS } from "../scanner/fetch.ts";
import { getJson } from "../scanner/http.ts";
import { callView, getCode, getStorageAt, wordToAddress } from "./rpc.ts";

export type Permissions = {
  proxy: { implementation: string | null; admin: string | null } | null;
  owner: { address: string; kind: "EOA" | "contract"; name: string | null } | null;
  paused: boolean | null; // null이면 paused() 없음
  // ABI에서 찾은 관리 함수 (검증된 소스가 있을 때만)
  adminFunctions: string[];
};

const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const OWNER = "0x8da5cb5b"; // owner()
const PAUSED = "0x5c975abb"; // paused()
const ADMIN_FN = /^(pause|unpause|upgradeTo|upgradeToAndCall|set\w*Verifier|update\w*Verifier|change\w*Verifier|emergency\w*|shutdown|kill|withdrawAll)$/i;

export async function checkPermissions(chain: Chain, address: string): Promise<Permissions> {
  const impl = wordToAddress(await getStorageAt(chain, address, EIP1967_IMPL));
  const admin = wordToAddress(await getStorageAt(chain, address, EIP1967_ADMIN));
  const ownerAddr = wordToAddress(await callView(chain, address, OWNER));
  const pausedWord = await callView(chain, address, PAUSED);

  let owner: Permissions["owner"] = null;
  if (ownerAddr) {
    const code = await getCode(chain, ownerAddr);
    let name: string | null = null;
    if (code !== "0x") {
      const info = await getJson<{ name: string | null }>(`${CHAINS[chain].blockscout}/api/v2/addresses/${ownerAddr}`).catch(
        () => ({ name: null }),
      );
      name = info.name;
    }
    owner = { address: ownerAddr, kind: code === "0x" ? "EOA" : "contract", name };
  }

  // 프록시면 관리 함수는 구현 쪽 ABI에 있다.
  const abiSources = [address, ...(impl ? [impl] : [])];
  const adminFunctions = new Set<string>();
  for (const a of abiSources) {
    const sc = await getJson<{ abi?: { type: string; name?: string }[] | null }>(
      `${CHAINS[chain].blockscout}/api/v2/smart-contracts/${a}`,
    ).catch(() => ({ abi: null }));
    for (const item of sc.abi ?? []) if (item.type === "function" && item.name && ADMIN_FN.test(item.name)) adminFunctions.add(item.name);
  }

  return {
    proxy: impl || admin ? { implementation: impl, admin } : null,
    owner,
    paused: pausedWord ? BigInt(pausedWord) !== 0n : null,
    adminFunctions: [...adminFunctions].sort(),
  };
}

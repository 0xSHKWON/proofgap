// 후보 하나를 소스 수집 → 템플릿 분류 → 검증키 추출 → 규칙 판정까지 돌린다.

import { join } from "node:path";
import { applyRules, type RuleId } from "../rules/index.ts";
import { type Chain, fetchContract } from "./fetch.ts";
import { type Fingerprint, fingerprint } from "../lib/fingerprint.ts";
import type { BytecodeAnalysis } from "./bytecode.ts";
import { scanSources, type TemplateId } from "./extract.ts";
import { mapLimit } from "./http.ts";
import { addCandidate, DATA_DIR, loadCandidates, readJson, saveCandidates, writeJson } from "./store.ts";

export type ScanStatus =
  | "detected" // 규칙에 걸림
  | "error" // 템플릿은 맞는데 추출 실패, 또는 수집 실패
  | "unclassified" // 검증기로 보이지만 템플릿 밖. 수동 검토 대기열
  | "clean" // 템플릿 검증기, 규칙에 안 걸림
  | "embedded" // 이 주소의 컨트랙트는 검증기가 아니지만, 소스 파일에 규칙에 걸리는 검증기가 함께 들어 있음
  | "proxy" // 소스에 검증기가 없고 구현 컨트랙트를 따로 스캔함
  | "not-verifier" // 검증된 소스에 검증기가 없음
  | "unverified" // 소스 미검증. bytecode 필드에 바이트코드 판정이 붙을 수 있음
  | "bytecode-detected"; // 소스 미검증인데 바이트코드 판정으로 탐지 (단계 4)

export type ScanRecord = {
  chain: Chain;
  address: string;
  name: string | null;
  status: ScanStatus;
  // main: 이 주소에 배포된 컨트랙트인지. false면 같은 소스 파일에 들어 있을 뿐 다른 주소에 배포된 것이다
  // (예: Veil 풀 소스에 평탄화된 Verifier). 판정 상태는 main만 보고 정한다.
  verifiers: {
    contract: string;
    main: boolean;
    template: TemplateId;
    rules: RuleId[];
    notes: string[];
    fingerprint?: Fingerprint; // R3용 δ와 회로 식별자
  }[];
  unclassified: { contract: string; reason: string }[];
  errors: string[];
  verifiedTwin: string | null;
  implementations: string[];
  g2GenCount: number | null;
  bytecode?: BytecodeAnalysis; // 바이트코드 판정 (proofgap bytecode scan)
  scannedAt: string;
};

export type ScanResults = Record<string, ScanRecord>;

export const resultsPath = (chain: Chain) => join(DATA_DIR, "results", `${chain}.json`);
export const loadResults = (chain: Chain) => readJson<ScanResults>(resultsPath(chain), {});

export async function scanAddress(chain: Chain, address: string): Promise<ScanRecord> {
  const base = {
    chain,
    address: address.toLowerCase(),
    name: null,
    verifiers: [],
    unclassified: [],
    errors: [],
    verifiedTwin: null,
    implementations: [],
    g2GenCount: null,
    scannedAt: new Date().toISOString(),
  };
  let info;
  try {
    info = await fetchContract(chain, address);
  } catch (e) {
    return { ...base, status: "error", errors: [`수집 실패: ${(e as Error).message}`] };
  }
  const { source, implementations, g2GenCount } = info;
  if (!source) {
    return { ...base, status: implementations.length ? "proxy" : "unverified", implementations, g2GenCount };
  }

  const scan = scanSources(source.files);
  // Blockscout가 알려준 컨트랙트 이름이 소스에 없으면 전부 이 주소의 것으로 본다.
  const isMain = (contract: string) => !scan.contracts.includes(source.name) || contract === source.name;
  const verifiers = scan.verifiers.map((v) => ({
    contract: v.contract,
    main: isMain(v.contract),
    template: v.template,
    rules: applyRules(v.vk),
    notes: v.notes,
    fingerprint: fingerprint(v.vk.delta, [v.vk.alpha, ...v.vk.ic]),
  }));
  const main = verifiers.filter((v) => v.main);
  const record: ScanRecord = {
    ...base,
    name: source.name,
    verifiers,
    unclassified: scan.unclassified.filter((u) => isMain(u.contract)).map(({ contract, reason }) => ({ contract, reason })),
    errors: scan.errors.filter((e) => isMain(e.contract)).map((e) => `${e.contract}: ${e.error}`),
    verifiedTwin: source.verifiedAtAddress ? null : source.verifiedTwin,
    implementations,
    g2GenCount,
    status: "not-verifier",
  };
  record.status = main.some((v) => v.rules.length > 0)
    ? "detected"
    : record.errors.length > 0
      ? "error"
      : record.unclassified.length > 0 && main.length === 0
        ? "unclassified"
        : main.length > 0
          ? "clean"
          : verifiers.some((v) => v.rules.length > 0)
            ? "embedded"
            : implementations.length > 0
              ? "proxy"
              : "not-verifier";
  return record;
}

export async function scanCandidates(
  chain: Chain,
  // rescan이면 이미 판정한 후보도 다시 돈다. statuses를 주면 그 상태인 것만 다시 돈다.
  opts: { concurrency: number; rescan: boolean; statuses?: ScanStatus[]; log: (s: string) => void },
): Promise<void> {
  const results = loadResults(chain);
  let done = 0;
  // 프록시의 구현 컨트랙트가 새 후보로 추가되므로 더 이상 새 후보가 없을 때까지 반복한다.
  for (let round = 0; round < 3; round++) {
    const candidates = loadCandidates(chain);
    const todo = Object.keys(candidates).filter(
      (a) => !results[a] || (opts.rescan && (!opts.statuses || opts.statuses.includes(results[a].status))),
    );
    if (todo.length === 0) break;
    opts.log(`${round === 0 ? "" : "구현 컨트랙트 "}${todo.length}개 스캔`);
    const added: [string, string][] = [];
    await mapLimit(todo, opts.concurrency, async (address) => {
      const r = await scanAddress(chain, address);
      results[address] = r;
      if (r.status === "proxy") for (const impl of r.implementations) added.push([impl, `impl-of:${address}`]);
      if (++done % 50 === 0) {
        writeJson(resultsPath(chain), results);
        opts.log(`  ${done}개 완료`);
      }
    });
    writeJson(resultsPath(chain), results);
    if (added.length === 0) break;
    const set = loadCandidates(chain);
    for (const [impl, via] of added) addCandidate(set, impl, via);
    saveCandidates(chain, set);
    opts.rescan = false;
  }
}

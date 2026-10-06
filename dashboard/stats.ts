// 대시보드용 집계. data/의 스캔·노출·트리아지 결과를 체인별로 센다.
// 공개용(PublicStats)에는 숫자만, 내부용(InternalStats)에는 개별 주소까지 담는다.

import { MATERIAL_USD } from "../exposure/assets.ts";
import { loadExposure } from "../exposure/index.ts";
import { findDeltaReuse, r3Entries } from "../rules/r3.ts";
import { type BytecodeValidation, validationPath } from "../scanner/bytecode-scan.ts";
import { type Chain, CHAINS } from "../scanner/fetch.ts";
import { loadResults, type ScanRecord } from "../scanner/scan.ts";
import { readJson } from "../scanner/store.ts";
import { checkTestVectors } from "../testvectors/check.ts";
import { loadTriage } from "../triage/index.ts";

export type ChainStats = {
  chain: Chain;
  candidates: number; // 수집한 후보
  verifiers: number; // 식별한 Groth16 검증기 (소스 템플릿 + 바이트코드 판정)
  detected: number; // R1·R2 탐지 (소스 + 바이트코드)
  suspect: number; // 바이트코드 의심 (사람이 확인할 것)
  material: number; // 탐지 중 호출자 자산이 기준 이상인 것
  r3: number; // R3 묶음에 속한 검증기
};

// 이미 공개 분석이 나온 사고(트리아지 priority "known")의 검증기와 호출자. 공개해도 되는 유일한 개별 주소다.
export type KnownIncident = { chain: Chain; verifier: string; name: string | null; callers: { address: string; name: string | null }[] };

export type Accuracy = {
  // 소스 판정이 있는 검증기로 바이트코드 판정을 확인한 결과 (체인 합계)
  labeled: number;
  falsePositive: number; // 소스 정상인데 바이트코드 detected
  falseNegative: number; // 소스 탐지인데 바이트코드 detected·suspect 둘 다 아님
  suspect: number; // 소스 탐지인데 바이트코드 suspect (사람 확인으로 넘어감)
  testVectors: { total: number; passed: number; sets: Record<string, number> };
};

export type PublicStats = {
  generatedAt: string;
  materialUsd: number;
  chains: ChainStats[];
  r3Groups: number;
  accuracy: Accuracy;
  known: KnownIncident[];
};

export type Detection = {
  chain: Chain;
  address: string;
  name: string | null;
  via: "소스" | "바이트코드";
  level: string;
  totalUsd: number;
  callers: number;
  priority: string;
  status: string;
};

export type InternalStats = PublicStats & {
  detections: Detection[];
  r3: { delta: string; circuits: number; members: string[] }[];
  suspects: { chain: Chain; address: string }[];
};

const isVerifier = (r: ScanRecord) =>
  r.verifiers.some((v) => v.main) || ["clean", "detected", "suspect"].includes(r.bytecode?.verdict ?? "");
const isDetected = (r: ScanRecord) => r.status === "detected" || r.status === "bytecode-detected";

function collectAccuracy(chains: Chain[]): Accuracy {
  const a = { labeled: 0, falsePositive: 0, falseNegative: 0, suspect: 0 };
  for (const chain of chains) {
    const v = readJson<BytecodeValidation | null>(validationPath(chain), null);
    for (const [k, n] of Object.entries(v?.matrix ?? {})) {
      const [src, bc] = k.split("→");
      a.labeled += n;
      if (src === "clean" && bc === "detected") a.falsePositive += n;
      if (src === "detected" && bc !== "detected" && bc !== "suspect") a.falseNegative += n;
      if (src === "detected" && bc === "suspect") a.suspect += n;
    }
  }
  return { ...a, testVectors: checkTestVectors() };
}

export function collectStats(): InternalStats {
  const chains = Object.keys(CHAINS) as Chain[];
  const r3 = findDeltaReuse(r3Entries());
  const r3Members = r3.flatMap((g) => g.members);
  const detections: Detection[] = [];
  const suspects: InternalStats["suspects"] = [];
  const known: KnownIncident[] = [];

  const perChain = chains.map((chain): ChainStats => {
    const records = Object.values(loadResults(chain));
    const exposure = loadExposure(chain);
    const triage = loadTriage(chain);
    for (const r of records.filter(isDetected)) {
      const e = exposure[r.address];
      const t = triage[r.address];
      if (t?.priority === "known") {
        known.push({
          chain,
          verifier: r.address,
          name: r.name,
          callers: (e?.callers ?? []).map((c) => ({ address: c.address, name: c.name })),
        });
      }
      detections.push({
        chain,
        address: r.address,
        name: r.name,
        via: r.status === "detected" ? "소스" : "바이트코드",
        level: e?.level ?? "미확인",
        totalUsd: e?.totalUsd ?? 0,
        callers: e?.callers.length ?? 0,
        priority: t?.priority ?? "-",
        status: t?.status ?? "-",
      });
    }
    for (const r of records) if (r.bytecode?.verdict === "suspect") suspects.push({ chain, address: r.address });
    return {
      chain,
      candidates: records.length,
      verifiers: records.filter(isVerifier).length,
      detected: records.filter(isDetected).length,
      suspect: records.filter((r) => r.bytecode?.verdict === "suspect").length,
      material: records.filter((r) => isDetected(r) && (exposure[r.address]?.totalUsd ?? 0) >= MATERIAL_USD).length,
      r3: r3Members.filter((m) => m.startsWith(`${chain}:`)).length,
    };
  });

  detections.sort((a, b) => b.totalUsd - a.totalUsd || a.chain.localeCompare(b.chain));
  return {
    generatedAt: new Date().toISOString(),
    materialUsd: MATERIAL_USD,
    chains: perChain,
    r3Groups: r3.length,
    accuracy: collectAccuracy(chains),
    known,
    detections,
    r3,
    suspects,
  };
}

// 공개용: 숫자만 남긴다.
export const toPublic = (s: InternalStats): PublicStats => ({
  generatedAt: s.generatedAt,
  materialUsd: s.materialUsd,
  chains: s.chains,
  r3Groups: s.r3Groups,
  accuracy: s.accuracy,
  known: s.known,
});

// 공개 산출물에 미공개 탐지 건(공개된 사고가 아닌 것)·의심·R3 주소가 하나라도 있으면 멈춘다.
export function assertNoPrivateAddresses(s: InternalStats, published: string): void {
  const knownSet = new Set(s.known.flatMap((k) => [k.verifier, ...k.callers.map((c) => c.address)]));
  const privateAddrs = [
    ...s.detections.map((d) => d.address),
    ...s.suspects.map((x) => x.address),
    ...s.r3.flatMap((g) => g.members.map((m) => m.split(":")[1]?.split(" ")[0] ?? "")),
  ].filter((a) => a && !knownSet.has(a));
  const lower = published.toLowerCase();
  const leaked = [...new Set(privateAddrs)].filter((a) => lower.includes(a.toLowerCase()));
  if (leaked.length) throw new Error(`공개 산출물에 미공개 주소 ${leaked.length}개가 들어 있음. 생성을 멈춤`);
}

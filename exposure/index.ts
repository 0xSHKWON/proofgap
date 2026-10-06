// 단계 2: 탐지된 검증기마다 호출자 → 잔고 → 권한을 이어 붙여 자산 유무를 판정한다.
// 결과는 data/exposure/에 저장한다. 개별 주소가 들어가므로 커밋하지 않는다.

import { join } from "node:path";
import type { Chain } from "../scanner/fetch.ts";
import { loadResults } from "../scanner/scan.ts";
import { DATA_DIR, readJson, writeJson } from "../scanner/store.ts";
import { type AssetLevel, MATERIAL_USD, type Snapshot, snapshot } from "./assets.ts";
import { loadBytecodeRefs } from "./bytecode-refs.ts";
import { type Caller, findCallers } from "./callers.ts";
import { checkPermissions, type Permissions } from "./permissions.ts";

export type ExposedCaller = Caller & { assets: Snapshot; permissions: Permissions };

export type ExposureRecord = {
  chain: Chain;
  verifier: string;
  name: string | null;
  callers: ExposedCaller[];
  callersTruncated: boolean;
  internalTxError?: string | null; // 호출 내역 조회 실패. 다른 경로로만 호출자를 찾은 것
  level: AssetLevel | "호출자 없음";
  totalUsd: number;
  checkedAt: string;
};

const exposurePath = (chain: Chain) => join(DATA_DIR, "exposure", `${chain}.json`);
export const loadExposure = (chain: Chain) => readJson<Record<string, ExposureRecord>>(exposurePath(chain), {});

const LEVEL_ORDER: ExposureRecord["level"][] = ["있음", "미미", "없음", "호출자 없음"];

export async function checkExposure(chain: Chain, verifier: string, name: string | null): Promise<ExposureRecord> {
  const refs = loadBytecodeRefs(chain)[verifier.toLowerCase()] ?? [];
  const { callers, truncated, internalTxError } = await findCallers(chain, verifier, refs);
  const exposed: ExposedCaller[] = [];
  for (const c of callers) {
    exposed.push({ ...c, assets: await snapshot(chain, c.address), permissions: await checkPermissions(chain, c.address) });
  }
  exposed.sort((a, b) => b.assets.totalUsd - a.assets.totalUsd);
  const totalUsd = exposed.reduce((s, c) => s + c.assets.totalUsd, 0);
  const level =
    exposed.length === 0
      ? "호출자 없음"
      : (LEVEL_ORDER.find((l) => exposed.some((c) => c.assets.level === l)) ?? "없음");
  return {
    chain,
    verifier: verifier.toLowerCase(),
    name,
    callers: exposed,
    callersTruncated: truncated,
    internalTxError,
    level,
    totalUsd,
    checkedAt: new Date().toISOString(),
  };
}

// 이미 확인한 검증기는 건너뛴다 (refresh면 전부 다시).
export async function runExposure(chain: Chain, opts: { refresh: boolean; log: (s: string) => void }): Promise<void> {
  const out = loadExposure(chain);
  const detected = Object.values(loadResults(chain)).filter(
    // 바이트코드로만 탐지한 건(bytecode-detected)도 같은 방식으로 확인한다.
    (r) => (r.status === "detected" || r.status === "bytecode-detected") && (opts.refresh || !out[r.address]),
  );
  opts.log(`[${chain}] 탐지 ${detected.length}건의 노출 확인`);
  for (const [i, r] of detected.entries()) {
    try {
      out[r.address] = await checkExposure(chain, r.address, r.name);
    } catch (e) {
      opts.log(`  ${r.address} 실패: ${(e as Error).message}. 다시 실행하면 재시도`);
      continue;
    }
    writeJson(exposurePath(chain), out);
    opts.log(`  ${i + 1}/${detected.length} ${r.name ?? "-"}: 호출자 ${out[r.address].callers.length}, ${out[r.address].level}`);
  }
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export function printExposure(chain: Chain): void {
  const records = Object.values(loadExposure(chain)).sort(
    (a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) || b.totalUsd - a.totalUsd,
  );
  console.log(`[${chain}] 노출 확인 ${records.length}건 — 비공개. 자산 기준 ${usd(MATERIAL_USD)} 이상`);
  for (const l of LEVEL_ORDER) console.log(`  ${l.padEnd(8)} ${records.filter((r) => r.level === l).length}`);

  for (const r of records) {
    console.log(`\n${r.verifier}  ${r.name ?? "-"}  → ${r.level} (${usd(r.totalUsd)})${r.internalTxError ? "  [호출 내역 확인 실패]" : r.callersTruncated ? "  [호출자 일부만 확인]" : ""}`);
    for (const c of r.callers) {
      const p = c.permissions;
      const perm = [
        p.proxy ? "프록시" : null,
        p.paused === true ? "정지됨" : p.paused === false ? "정지 가능" : null,
        p.owner ? `owner ${p.owner.kind}${p.owner.name ? `(${p.owner.name})` : ""}` : null,
        p.adminFunctions.length ? `관리함수 ${p.adminFunctions.join(",")}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      const top = c.assets.tokens.slice(0, 3).map((t) => `${t.symbol} ${usd(t.usd)}`).join(" ");
      console.log(
        `  ${c.address}  ${(c.name ?? "-").padEnd(24)} ${c.assets.level} ${usd(c.assets.totalUsd)}` +
          `${top ? ` [${top}]` : ""}  via ${c.via.join("+")}${c.reference ? `(${c.reference})` : ""}${c.calls ? ` 호출 ${c.calls}` : ""}` +
          `${perm ? `  | ${perm}` : ""}`,
      );
    }
  }
}

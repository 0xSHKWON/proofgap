// 바이트코드에 탐지된 검증기 주소가 immutable로 박힌 컨트랙트를 BigQuery로 찾는다 (이더리움, Polygon).
// 배포자가 다르고 아직 검증기를 부른 적 없는 호출자를 잡기 위한 경로다.
// 검증기 주소 목록은 data/results에서 실행할 때 만들고, 쿼리도 결과도 저장소에 남기지 않는다.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { type Chain, CHAINS } from "../scanner/fetch.ts";
import { loadResults } from "../scanner/scan.ts";
import { DATA_DIR, readJson, writeJson } from "../scanner/store.ts";

export type BytecodeRefs = Record<string, string[]>; // 검증기 → 바이트코드에 그 주소가 있는 컨트랙트들

const refsPath = (chain: Chain) => join(DATA_DIR, "exposure", `${chain}.bytecode-refs.json`);
export const loadBytecodeRefs = (chain: Chain) => readJson<BytecodeRefs>(refsPath(chain), {});

export function runBytecodeRefs(chain: Chain, opts: { dryRun: boolean; log: (s: string) => void }): void {
  const table = CHAINS[chain].bigquery;
  if (!table) throw new Error(`${chain}: 바이트코드가 있는 BigQuery 공개 테이블이 없음`);
  const verifiers = Object.values(loadResults(chain))
    .filter((r) => r.status === "detected" || r.status === "bytecode-detected")
    .map((r) => r.address.slice(2));
  if (verifiers.length === 0) return opts.log("탐지된 검증기가 없음");
  const sql = `
SELECT address, REGEXP_EXTRACT_ALL(bytecode, r'(${verifiers.join("|")})') AS refs
FROM \`${table}\`
WHERE REGEXP_CONTAINS(bytecode, r'(${verifiers.join("|")})')`;
  const args = ["query", "--nouse_legacy_sql", "--format=json", "--max_rows=1000000"];
  if (opts.dryRun) {
    const out = execFileSync("bq", [...args, "--dry_run"], { encoding: "utf8", input: sql });
    const bytes = Number((JSON.parse(out) as { statistics: { totalBytesProcessed: string } }).statistics.totalBytesProcessed);
    return opts.log(`검증기 ${verifiers.length}개, 처리량 ${(bytes / 1e9).toFixed(1)} GB`);
  }
  const rows = JSON.parse(execFileSync("bq", args, { encoding: "utf8", input: sql, maxBuffer: 1 << 28 }) || "[]") as {
    address: string;
    refs: string[];
  }[];
  const out: BytecodeRefs = {};
  for (const row of rows) {
    for (const ref of new Set(row.refs)) {
      const v = `0x${ref}`;
      if (row.address.toLowerCase() === v) continue;
      (out[v] ??= []).push(row.address.toLowerCase());
    }
  }
  writeJson(refsPath(chain), out);
  opts.log(`바이트코드 참조: 검증기 ${Object.keys(out).length}개에 컨트랙트 ${rows.length}개`);
}


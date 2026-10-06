// 바이트코드 판정을 스캔 결과에 적용한다.
//   check: 소스로 판정이 끝난 검증기로 바이트코드 판정의 정확도를 잰다 (정답 = 소스 판정)
//   scan:  소스 미검증 후보에 바이트코드 판정을 붙인다. 탐지면 상태를 bytecode-detected로 바꾼다

import { join } from "node:path";
import { getCode } from "../exposure/rpc.ts";
import { analyzeBytecode, type BytecodeVerdict } from "./bytecode.ts";
import type { Chain } from "./fetch.ts";
import { mapLimit } from "./http.ts";
import { loadResults, resultsPath } from "./scan.ts";
import { DATA_DIR, writeJson } from "./store.ts";

// 정확도 확인 결과. 대시보드의 공개 페이지가 읽는다 (개별 주소 없음).
export type BytecodeValidation = { chain: Chain; checkedAt: string; matrix: Record<string, number> };
export const validationPath = (chain: Chain) => join(DATA_DIR, "validation", `${chain}.bytecode.json`);

export async function checkBytecode(chain: Chain, opts: { log: (s: string) => void }): Promise<void> {
  const labeled = Object.values(loadResults(chain)).filter((r) => r.status === "detected" || r.status === "clean");
  opts.log(`[${chain}] 소스 판정이 있는 검증기 ${labeled.length}개로 바이트코드 판정 확인`);
  const m: Record<string, number> = {};
  const misses: string[] = [];
  await mapLimit(labeled, 4, async (r) => {
    const { verdict } = analyzeBytecode(await getCode(chain, r.address));
    const key = `${r.status}→${verdict}`;
    m[key] = (m[key] ?? 0) + 1;
    // 놓침: 소스 탐지인데 바이트코드가 detected·suspect 둘 다 아님. 오탐: 소스 정상인데 바이트코드 detected
    const flagged = verdict === "detected" || verdict === "suspect";
    if ((r.status === "detected" && !flagged) || (r.status === "clean" && verdict === "detected")) {
      misses.push(`${r.address} ${r.name ?? "-"} ${key}`);
    }
  });
  for (const [k, n] of Object.entries(m).sort()) opts.log(`  소스 ${k.replace("→", " → 바이트코드 ")}: ${n}`);
  writeJson(validationPath(chain), { chain, checkedAt: new Date().toISOString(), matrix: m } satisfies BytecodeValidation);
  if (misses.length) {
    opts.log("  판정이 갈린 것 — 비공개");
    for (const x of misses) opts.log(`    ${x}`);
  }
}

export async function scanBytecode(chain: Chain, opts: { log: (s: string) => void }): Promise<void> {
  const results = loadResults(chain);
  const todo = Object.values(results).filter((r) => r.status === "unverified" || r.status === "bytecode-detected");
  opts.log(`[${chain}] 소스 미검증 ${todo.length}개 바이트코드 판정`);
  const tally: Record<BytecodeVerdict, number> = { detected: 0, suspect: 0, clean: 0, "not-groth16": 0 };
  await mapLimit(todo, 4, async (r) => {
    const a = analyzeBytecode(await getCode(chain, r.address));
    r.bytecode = a;
    // suspect는 상태를 바꾸지 않고 bytecode 필드로만 남긴다 (수동 확인 대기)
    r.status = a.verdict === "detected" ? "bytecode-detected" : "unverified";
    tally[a.verdict]++;
  });
  writeJson(resultsPath(chain), results);
  opts.log(`  탐지 ${tally.detected}, 의심 ${tally.suspect}, 정상 ${tally.clean}, Groth16 아님 ${tally["not-groth16"]}`);
}

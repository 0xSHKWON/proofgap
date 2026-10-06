// R3: 같은 δ가 서로 다른 회로의 검증기에서 재사용됨 (심각도: 정보)
//
// Phase 2 기여가 회로마다 따로 이뤄졌다면 δ는 회로마다 다르다. 서로 다른 회로가 같은 δ를 쓰면
// 같은 기여(또는 같은 비컨 값만으로 만든 기여)를 재사용했다는 뜻이다. 한 회로의 δ 비밀이 새면
// 다른 회로도 같이 깨지고, 비컨만으로 만든 기여라면 δ를 누구나 계산할 수 있다.
// 같은 회로를 여러 번(여러 체인에) 배포해서 δ가 같은 것은 정상이므로 회로를 구분한다.
// 회로가 다르면 α(Phase 1에서 옴) 하나만 겹치므로, G1 점이 두 개 이상 겹치면 같은 회로로 묶는다.
// 점이 하나 이하라 회로를 알 수 없는 항목은 회로 개수를 늘리지 않는다.
// δ가 생성원인 경우는 R1·R2가 다루므로 뺀다.

import { G2_GENERATOR } from "../lib/bn254.ts";
import { type Fingerprint, g2Key } from "../lib/fingerprint.ts";
import { type Chain, CHAINS } from "../scanner/fetch.ts";
import { loadResults } from "../scanner/scan.ts";

export type R3Entry = { id: string; fingerprint: Fingerprint };
export type R3Group = { delta: string; circuits: number; members: string[] };

const SAME_CIRCUIT_OVERLAP = 2;

function countCircuits(list: R3Entry[]): number {
  const known = list.filter((e) => e.fingerprint.points.length >= SAME_CIRCUIT_OVERLAP);
  const parent = known.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < known.length; i++) {
    const a = new Set(known[i].fingerprint.points);
    for (let j = i + 1; j < known.length; j++) {
      const overlap = known[j].fingerprint.points.filter((p) => a.has(p)).length;
      if (overlap >= SAME_CIRCUIT_OVERLAP) parent[find(i)] = find(j);
    }
  }
  return new Set(known.map((_, i) => find(i))).size;
}

const GENERATOR_KEY = g2Key(G2_GENERATOR);

export function findDeltaReuse(entries: R3Entry[]): R3Group[] {
  const byDelta = new Map<string, R3Entry[]>();
  for (const e of entries) {
    if (e.fingerprint.delta === GENERATOR_KEY) continue;
    const list = byDelta.get(e.fingerprint.delta) ?? [];
    list.push(e);
    byDelta.set(e.fingerprint.delta, list);
  }
  const groups: R3Group[] = [];
  for (const [delta, list] of byDelta) {
    const circuits = countCircuits(list);
    if (circuits >= 2) groups.push({ delta, circuits, members: list.map((e) => e.id).sort() });
  }
  return groups.sort((a, b) => b.members.length - a.members.length);
}

// ── 스캔 결과 전체에 적용 ───────────────────────────────────

export function r3Entries(): R3Entry[] {
  const out: R3Entry[] = [];
  for (const chain of Object.keys(CHAINS) as Chain[]) {
    for (const r of Object.values(loadResults(chain))) {
      const fp = r.verifiers.find((v) => v.main)?.fingerprint ?? r.bytecode?.fingerprint;
      if (fp) out.push({ id: `${chain}:${r.address} ${r.name ?? "-"}${r.verifiers.length ? "" : " (바이트코드)"}`, fingerprint: fp });
    }
  }
  return out;
}

export function printR3(): void {
  const entries = r3Entries();
  const groups = findDeltaReuse(entries);
  console.log(`R3: 지문 ${entries.length}개 중 δ 재사용 묶음 ${groups.length}개 — 비공개`);
  for (const g of groups) {
    console.log(`\nδ ${g.delta.slice(0, 16)}…  회로 ${g.circuits}개, 검증기 ${g.members.length}개`);
    for (const m of g.members) console.log(`  ${m}`);
  }
}

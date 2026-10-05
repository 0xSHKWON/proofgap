// 스캔 데이터 저장소. data/는 .gitignore 대상이다.
// 탐지 결과에는 아직 제보하지 않은 취약 주소가 들어갈 수 있으므로 절대 커밋하지 않는다.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Chain } from "./fetch.ts";

export const DATA_DIR = join(new URL("..", import.meta.url).pathname, "data");

export function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
}

// 중간에 죽어도 파일이 깨지지 않도록 임시 파일에 쓴 뒤 바꿔치기한다.
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

// ── 후보 ─────────────────────────────────────────────────────

export type Candidate = {
  address: string;
  via: string[]; // 어떤 경로로 찾았는지: precompile, name:Verifier, bigquery, impl-of:0x…
  name: string | null;
  precompileCalls?: number;
  g2GenCount?: number; // 바이트코드에 G2 생성원 좌표가 나온 횟수 (bigquery 경로만)
};

export type CandidateSet = Record<string, Candidate>;

export const candidatesPath = (chain: Chain) => join(DATA_DIR, "candidates", `${chain}.json`);
export const loadCandidates = (chain: Chain) => readJson<CandidateSet>(candidatesPath(chain), {});
export const saveCandidates = (chain: Chain, set: CandidateSet) => writeJson(candidatesPath(chain), set);

export function addCandidate(set: CandidateSet, address: string, via: string, name: string | null = null): Candidate {
  const key = address.toLowerCase();
  const c = (set[key] ??= { address: key, via: [], name: null });
  if (!c.via.includes(via)) c.via.push(via);
  c.name ??= name;
  return c;
}

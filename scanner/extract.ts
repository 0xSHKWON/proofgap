// snarkjs Groth16 검증기 템플릿을 식별하고 검증키를 뽑아 정규화한다.
//
// 템플릿 경계 (snarkjs templates/verifier_groth16.sol.ejs 기준):
//   구형  ≤ 0.6.11  contract Verifier + library Pairing, verifyingKey()에서 vk.delta2 = Pairing.G2Point(...)
//   신형  ≥ 0.7.0   contract Groth16Verifier, uint256 constant deltax1 ... + 어셈블리 checkField
// 컨트랙트 이름은 배포자가 자주 바꾸므로(예: Veil의 Verifier, Foom의 WithdrawG16Verifier) 이름이 아니라 본문 구조로 판별한다.

import { type G1, type G2, isOnCurveG1, isOnCurveG2 } from "../lib/bn254.ts";
import { type ContractBlock, type SourceFile, splitContracts } from "./source.ts";

export type TemplateId = "snarkjs-groth16-new" | "snarkjs-groth16-old";

export type VerifyingKey = { alpha: G1; beta: G2; gamma: G2; delta: G2; ic: G1[] };

export type VerifierHit = {
  file: string;
  contract: string;
  template: TemplateId;
  vk: VerifyingKey;
  notes: string[];
};

export type ScanResult = {
  verifiers: VerifierHit[];
  // 검증기로 보이지만 템플릿이 맞지 않는 컨트랙트. 수동 검토 대기열로 간다.
  unclassified: { file: string; contract: string; reason: string }[];
  // 템플릿은 맞았는데 검증키를 제대로 뽑지 못한 컨트랙트.
  errors: { file: string; contract: string; template: TemplateId; error: string }[];
};

class ExtractError extends Error {}

export function scanSources(files: SourceFile[]): ScanResult {
  const result: ScanResult = { verifiers: [], unclassified: [], errors: [] };
  for (const block of splitContracts(files)) {
    if (block.kind !== "contract") continue;
    const template = classify(block.body);
    if (template === null) {
      const reason = looksLikeVerifier(block.body);
      if (reason) result.unclassified.push({ file: block.file, contract: block.name, reason });
      continue;
    }
    try {
      const notes: string[] = [];
      const vk = template === "snarkjs-groth16-new" ? extractNew(block, notes) : extractOld(block, notes);
      result.verifiers.push({ file: block.file, contract: block.name, template, vk, notes });
    } catch (e) {
      if (!(e instanceof ExtractError)) throw e;
      result.errors.push({ file: block.file, contract: block.name, template, error: e.message });
    }
  }
  return result;
}

const NEW_REQUIRED = ["alphax", "alphay", "betax1", "gammax1", "deltax1", "deltay2", "IC0x", "IC0y"];

export function classify(body: string): TemplateId | null {
  const constants = new Set(Array.from(body.matchAll(CONSTANT), (m) => m[1]));
  if (NEW_REQUIRED.every((name) => constants.has(name))) return "snarkjs-groth16-new";
  if (/function\s+verifyingKey\s*\(/.test(body) && /vk\.delta2\s*=\s*Pairing\.G2Point\s*\(/.test(body)) {
    return "snarkjs-groth16-old";
  }
  return null;
}

function looksLikeVerifier(body: string): string | null {
  if (/function\s+verifyProof\s*\(/.test(body)) return "verifyProof 함수가 있음";
  if (/staticcall\s*\([^;]*?,\s*(?:8|0x0*8)\s*,/.test(body)) return "페어링 프리컴파일(0x08) 호출이 있음";
  return null;
}

// ── 신형 템플릿 ──────────────────────────────────────────────

const NUM = String.raw`(0x[0-9a-fA-F]+|\d+)`;
const CONSTANT = new RegExp(String.raw`\buint256\s+constant\s+(\w+)\s*=\s*${NUM}\s*;`, "g");

function extractNew(block: ContractBlock, notes: string[]): VerifyingKey {
  const c = new Map<string, bigint>();
  for (const m of block.body.matchAll(CONSTANT)) c.set(m[1], BigInt(m[2]));
  const get = (name: string): bigint => {
    const v = c.get(name);
    if (v === undefined) throw new ExtractError(`상수 ${name}이 없음`);
    return v;
  };
  // 템플릿은 G2를 EIP-197 순서 (x1=허수부, x2=실수부)로 쓴다.
  const g2 = (p: string): G2 =>
    normalizeG2(p, [get(`${p}x1`), get(`${p}x2`), get(`${p}y1`), get(`${p}y2`)], notes);

  const ic: G1[] = [];
  for (let i = 0; c.has(`IC${i}x`); i++) ic.push(checkG1(`IC${i}`, { x: get(`IC${i}x`), y: get(`IC${i}y`) }));

  return {
    alpha: checkG1("alpha", { x: get("alphax"), y: get("alphay") }),
    beta: g2("beta"),
    gamma: g2("gamma"),
    delta: g2("delta"),
    ic,
  };
}

// ── 구형 템플릿 ──────────────────────────────────────────────

function extractOld(block: ContractBlock, notes: string[]): VerifyingKey {
  // 더 오래된 변형은 숫자를 uint256(...)로 감싸 둔다.
  const body = block.body.replace(new RegExp(String.raw`uint256\s*\(\s*${NUM}\s*\)`, "g"), "$1");
  const g1Re = (lhs: string) =>
    new RegExp(String.raw`${lhs}\s*=\s*Pairing\.G1Point\s*\(\s*${NUM}\s*,\s*${NUM}\s*\)`, "g");
  const g2Re = (lhs: string) =>
    new RegExp(
      String.raw`${lhs}\s*=\s*Pairing\.G2Point\s*\(\s*\[\s*${NUM}\s*,\s*${NUM}\s*\]\s*,\s*\[\s*${NUM}\s*,\s*${NUM}\s*\]\s*\)`,
      "g",
    );
  const one = (re: RegExp, label: string): RegExpExecArray => {
    const all = Array.from(body.matchAll(re));
    if (all.length !== 1) throw new ExtractError(`${label} 대입이 ${all.length}개`);
    return all[0] as RegExpExecArray;
  };

  const a = one(g1Re(String.raw`vk\.(?:alfa1|alpha1)`), "vk.alfa1");
  const g2 = (name: string): G2 => {
    const m = one(g2Re(String.raw`vk\.${name}2`), `vk.${name}2`);
    return normalizeG2(name, [BigInt(m[1]), BigInt(m[2]), BigInt(m[3]), BigInt(m[4])], notes);
  };

  const icEntries = new Map<number, G1>();
  for (const m of body.matchAll(g1Re(String.raw`vk\.IC\[(\d+)\]`))) {
    const i = Number(m[1]);
    if (icEntries.has(i)) throw new ExtractError(`vk.IC[${i}] 대입이 여러 개`);
    icEntries.set(i, checkG1(`IC${i}`, { x: BigInt(m[2]), y: BigInt(m[3]) }));
  }
  const ic: G1[] = [];
  for (let i = 0; i < icEntries.size; i++) {
    const p = icEntries.get(i);
    if (!p) throw new ExtractError(`vk.IC[${i}]가 빠짐`);
    ic.push(p);
  }
  if (ic.length === 0) throw new ExtractError("vk.IC가 없음");

  return {
    alpha: checkG1("alpha", { x: BigInt(a[1]), y: BigInt(a[2]) }),
    beta: g2("beta"),
    gamma: g2("gamma"),
    delta: g2("delta"),
    ic,
  };
}

// ── 정규화 ───────────────────────────────────────────────────

function checkG1(label: string, p: G1): G1 {
  if (!isOnCurveG1(p)) throw new ExtractError(`${label}가 G1 위의 점이 아님`);
  return p;
}

// raw = 소스에 적힌 순서 그대로 [x1, x2, y1, y2]. 템플릿 기준으로는 (허수부, 실수부)지만,
// 손으로 고친 검증기는 순서가 뒤집혀 있을 수 있어 곡선 방정식으로 어느 쪽인지 확인한다.
function normalizeG2(label: string, raw: [bigint, bigint, bigint, bigint], notes: string[]): G2 {
  const [x1, x2, y1, y2] = raw;
  const eip197: G2 = { x: { re: x2, im: x1 }, y: { re: y2, im: y1 } };
  if (isOnCurveG2(eip197)) return eip197;
  const swapped: G2 = { x: { re: x1, im: x2 }, y: { re: y1, im: y2 } };
  if (isOnCurveG2(swapped)) {
    notes.push(`${label}: G2 좌표가 (실수부, 허수부) 순서로 적혀 있음`);
    return swapped;
  }
  throw new ExtractError(`${label}가 어느 좌표 순서로도 G2 위의 점이 아님`);
}

// 소스 없이 배포된 바이트코드만으로 셋업 누락을 판정한다 (단계 4).
//
// 생성원 등장 횟수를 세는 방식(g2GenCount)은 양쪽으로 틀린다. 옵티마이저가 같은 상수를 합치면
// 결함이 있어도 1번만 나오고(L15), 검증키를 돌려주는 배열이 있으면 정상이어도 2번 나온다(L16).
//
// 대신 PUSH 상수를 순서대로 뽑아, 연속된 4개가 G2 위의 점이 되는 곳을 모두 찾는다.
// Groth16 검증키에는 G2 점이 β, γ, δ 셋 있고, 템플릿은 β·γ·δ를 연달아 넣는다. snarkjs는 보통 γ를 생성원으로 둔다.
//   β → X → X (같은 점이 연달아 두 번)              → γ == δ → detected (R1. X가 생성원이면 R2도)
//   그 패턴은 없고 생성원과 다른 G2 점 하나뿐       → suspect
//   서로 다른 G2 점이 3개 이상                      → clean (γ까지 무작위인 셋업도 포함)
// 소스 판정이 있는 검증기로 확인한 결과는 docs/troubleshooting.md L28~L30.
// suspect에는 옵티마이저가 같은 상수를 합친 진짜 결함(구형 템플릿, L15)과,
// δ가 상수로 박혀 있지 않은 검증기(스토리지·calldata에서 읽음)가 섞여 있어 사람이 확인한다.

import { G2_GENERATOR, g2Eq, type G2, isOnCurveG2 } from "../lib/bn254.ts";

export type BytecodeVerdict = "detected" | "suspect" | "clean" | "not-groth16";

export type BytecodeAnalysis = {
  verdict: BytecodeVerdict;
  g2Points: number; // 서로 다른 G2 점 개수 (생성원 포함)
  generatorSites: number; // 생성원이 G2 점으로 나온 자리 수
};

// 좌표는 254비트라 앞자리가 0인 바이트가 몇 개 있어도 PUSH24 이상으로 들어간다.
const MIN_PUSH_BYTES = 24;

export function pushConstants(bytecode: string): bigint[] {
  const hex = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
  const out: bigint[] = [];
  for (let i = 0; i < hex.length; ) {
    const op = parseInt(hex.slice(i, i + 2), 16);
    i += 2;
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      if (n >= MIN_PUSH_BYTES && i + n * 2 <= hex.length) out.push(BigInt(`0x${hex.slice(i, i + n * 2)}`));
      i += n * 2;
    }
  }
  return out;
}

function g2At(c: bigint[], i: number): G2 | null {
  // 템플릿 순서 (x 허수부, x 실수부, y 허수부, y 실수부), 아니면 반대 순서
  const eip197: G2 = { x: { re: c[i + 1], im: c[i] }, y: { re: c[i + 3], im: c[i + 2] } };
  if (isOnCurveG2(eip197)) return eip197;
  const swapped: G2 = { x: { re: c[i], im: c[i + 1] }, y: { re: c[i + 2], im: c[i + 3] } };
  return isOnCurveG2(swapped) ? swapped : null;
}

export function analyzeBytecode(bytecode: string): BytecodeAnalysis {
  const c = pushConstants(bytecode);
  const at: (G2 | null)[] = c.map((_, i) => (i + 3 < c.length ? g2At(c, i) : null));
  const isGen = (p: G2 | null) => p !== null && g2Eq(p, G2_GENERATOR);
  const points: G2[] = [];
  let generatorSites = 0;
  let pattern = false;
  for (let i = 0; i < at.length; i++) {
    const p = at[i];
    if (!p) continue;
    if (isGen(p)) generatorSites++;
    if (!points.some((q) => g2Eq(p, q))) points.push(p);
    const g = at[i + 4] ?? null;
    const d = at[i + 8] ?? null;
    if (g && d && g2Eq(g, d) && !g2Eq(p, g)) pattern = true;
  }
  const others = points.filter((p) => !isGen(p)).length;
  const verdict: BytecodeVerdict = pattern
    ? "detected"
    : points.length >= 3
      ? "clean"
      : generatorSites > 0 && others === 1
        ? "suspect"
        : "not-groth16";
  return { verdict, g2Points: points.length, generatorSites };
}

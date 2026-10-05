// BN254 (alt_bn128) 상수와 최소한의 필드 연산.
// 추출한 검증키 좌표가 실제 곡선 위의 점인지 확인하는 데만 쓴다.

export const P = 21888242871839275222246405745257275088696311157297823662689037894645226208583n; // 베이스 필드
export const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n; // 스칼라 필드

export type Fp2 = { re: bigint; im: bigint };
export type G1 = { x: bigint; y: bigint };
export type G2 = { x: Fp2; y: Fp2 };

// EIP-197의 G2 기본 생성원. snarkjs는 γ를 항상 이 값으로 두고,
// Phase 2를 거치지 않으면 δ도 이 값으로 남는다.
export const G2_GENERATOR: G2 = {
  x: {
    re: 10857046999023057135944570762232829481370756359578518086990519993285655852781n,
    im: 11559732032986387107991004021392285783925812861821192530917403151452391805634n,
  },
  y: {
    re: 8495653923123431417604973247489272438418190587263600148770280649306958101930n,
    im: 4082367875863433681332203403145435568316851327593401208105741076214120093531n,
  },
};

const mod = (a: bigint): bigint => ((a % P) + P) % P;

function pow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

const inv = (a: bigint): bigint => pow(a, P - 2n);

const fp2Add = (a: Fp2, b: Fp2): Fp2 => ({ re: mod(a.re + b.re), im: mod(a.im + b.im) });
const fp2Mul = (a: Fp2, b: Fp2): Fp2 => ({
  re: mod(a.re * b.re - a.im * b.im),
  im: mod(a.re * b.im + a.im * b.re),
});
const fp2Eq = (a: Fp2, b: Fp2): boolean => a.re === b.re && a.im === b.im;

// 트위스트 곡선 계수 b' = 3 / (9 + u) = 3(9 - u) / 82
const TWIST_B: Fp2 = { re: mod(27n * inv(82n)), im: mod(-3n * inv(82n)) };

const inField = (v: bigint): boolean => v >= 0n && v < P;

export function isOnCurveG1(p: G1): boolean {
  if (!inField(p.x) || !inField(p.y)) return false;
  return mod(p.y * p.y) === mod(p.x * p.x * p.x + 3n);
}

export function isOnCurveG2(p: G2): boolean {
  const coords = [p.x.re, p.x.im, p.y.re, p.y.im];
  if (!coords.every(inField)) return false;
  const lhs = fp2Mul(p.y, p.y);
  const rhs = fp2Add(fp2Mul(fp2Mul(p.x, p.x), p.x), TWIST_B);
  return fp2Eq(lhs, rhs);
}

export const g2Eq = (a: G2, b: G2): boolean => fp2Eq(a.x, b.x) && fp2Eq(a.y, b.y);

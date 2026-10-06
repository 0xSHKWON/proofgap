// 검증키 지문. R3(같은 δ를 서로 다른 회로가 재사용)를 판정하는 데 쓴다.
//   delta   δ 좌표 (실수부·허수부 순서로 정규화한 16진수)
//   points  α와 IC 점 (x 좌표 앞 16자리, 정렬). 회로가 다르면 IC가 전부 달라 α 하나만 겹친다.
// 바이트코드에서 뽑은 점은 컴파일 결과에 따라 하나쯤 빠지거나 더 잡힐 수 있고(L35), gnark 변형은 소스에서
// IC를 못 뽑는다(L17). 그래서 해시로 정확히 비교하지 않고, 두 점 이상 겹치면 같은 회로로 본다 (rules/r3.ts).

import type { G1, G2 } from "./bn254.ts";

export type Fingerprint = { delta: string; points: string[] };

const hex = (v: bigint) => v.toString(16).padStart(64, "0");

export const g2Key = (p: G2): string => [p.x.re, p.x.im, p.y.re, p.y.im].map(hex).join("");

export const pointKeys = (points: G1[]): string[] => [...new Set(points.map((p) => hex(p.x).slice(0, 16)))].sort();

export const fingerprint = (delta: G2, alphaAndIc: G1[]): Fingerprint => ({ delta: g2Key(delta), points: pointKeys(alphaAndIc) });

// 탐지 규칙. 조건·근거·오탐 주의점은 docs/rules.md에 있다.
//
// γ가 G2 생성원인 것은 정상이다. snarkjs는 γ를 생성원으로 고정하고 Phase 2에서 δ만 무작위화한다.
// 그래서 "γ == 생성원"은 규칙이 될 수 없고, 셋업 누락은 δ 쪽에서 본다.

import { G2_GENERATOR, g2Eq } from "../lib/bn254.ts";
import type { VerifyingKey } from "../scanner/extract.ts";

export type RuleId = "R1" | "R2";
export type Severity = "critical" | "high" | "info";

export type Rule = {
  id: RuleId;
  severity: Severity;
  title: string;
  test: (vk: VerifyingKey) => boolean;
};

export const RULES: Rule[] = [
  {
    id: "R1",
    severity: "critical",
    title: "γ == δ",
    test: (vk) => g2Eq(vk.gamma, vk.delta),
  },
  {
    id: "R2",
    severity: "critical",
    title: "δ == BN254 G2 기본 생성원",
    test: (vk) => g2Eq(vk.delta, G2_GENERATOR),
  },
];

export function applyRules(vk: VerifyingKey): RuleId[] {
  return RULES.filter((r) => r.test(vk)).map((r) => r.id);
}

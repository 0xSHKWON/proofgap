// manifest.json의 모든 벡터를 분류 → 추출 → 규칙 판정에 넣고 기대 결과와 비교한다.
// bytecodeVectors는 소스 없이 바이트코드 판정만 확인한다.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fingerprint } from "../lib/fingerprint.ts";
import { applyRules, RULES, type RuleId } from "../rules/index.ts";
import { findDeltaReuse } from "../rules/r3.ts";
import { analyzeBytecode } from "../scanner/bytecode.ts";
import { scanSources, type TemplateId } from "../scanner/extract.ts";
import { loadBytecodeVectors, loadManifest, loadR3Groups, loadVectorSource, ROOT, type Vector } from "./manifest.ts";

type Outcome = {
  vector: Vector;
  template: TemplateId | null;
  rules: RuleId[];
  pass: boolean;
  detail: string;
};

export type CheckSummary = { total: number; passed: number; sets: Record<string, number> };

// log를 넘기지 않으면 조용히 결과만 돌려준다 (대시보드용).
export function checkTestVectors(log: (s: string) => void = () => {}): CheckSummary {
  const outcomes = loadManifest().map(evaluate);

  for (const o of outcomes) {
    const mark = o.pass ? "PASS" : "FAIL";
    const got = `${o.template ?? "미분류"} [${o.rules.join(",")}]`;
    log(`${mark}  ${o.vector.id.padEnd(34)} ${o.vector.set.padEnd(18)} ${got}${o.detail ? `  — ${o.detail}` : ""}`);
  }

  log("\n규칙별 혼동 행렬 (분류된 벡터만)");
  for (const rule of RULES) {
    const m = { tp: 0, fp: 0, fn: 0, tn: 0 };
    for (const o of outcomes) {
      if (o.template === null) continue;
      const expected = o.vector.expect.rules.includes(rule.id);
      const actual = o.rules.includes(rule.id);
      m[expected ? (actual ? "tp" : "fn") : actual ? "fp" : "tn"]++;
    }
    log(`  ${rule.id} ${rule.title.padEnd(26)} TP ${m.tp}  FP ${m.fp}  FN ${m.fn}  TN ${m.tn}`);
  }

  log("\n바이트코드 판정");
  let bcFailed = 0;
  const bcVectors = loadBytecodeVectors();
  for (const v of bcVectors) {
    const { verdict } = analyzeBytecode(readFileSync(join(ROOT, v.path), "utf8").trim());
    const pass = verdict === v.expect;
    if (!pass) bcFailed++;
    log(`${pass ? "PASS" : "FAIL"}  ${v.id.padEnd(40)} ${verdict}${pass ? "" : `  — 기대 ${v.expect}`}`);
  }

  // R3: 모든 소스 벡터의 지문을 모아 δ 재사용 묶음이 기대와 같은지 본다.
  log("\nR3 (같은 δ를 서로 다른 회로가 재사용)");
  const entries = loadManifest().flatMap((v) => {
    const hit = scanSources(loadVectorSource(v)).verifiers.find((h) => !v.contract || h.contract === v.contract);
    return hit ? [{ id: v.id, fingerprint: fingerprint(hit.vk.delta, [hit.vk.alpha, ...hit.vk.ic]) }] : [];
  });
  const key = (ids: string[]) => [...ids].sort().join(",");
  const got = findDeltaReuse(entries).map((g) => key(g.members));
  const want = loadR3Groups().map(key);
  const r3Pass = got.length === want.length && want.every((w) => got.includes(w));
  log(`${r3Pass ? "PASS" : "FAIL"}  묶음 ${got.length}개${r3Pass ? "" : `  — 기대 ${JSON.stringify(want)}, 실제 ${JSON.stringify(got)}`}`);

  const failed = outcomes.filter((o) => !o.pass).length + (r3Pass ? 0 : 1);
  const total = outcomes.length + bcVectors.length + 1;
  log(`\n${total - failed - bcFailed}/${total} 통과`);
  const sets: Record<string, number> = { "바이트코드": bcVectors.length, R3: 1 };
  for (const o of outcomes) sets[o.vector.set] = (sets[o.vector.set] ?? 0) + 1;
  return { total, passed: total - failed - bcFailed, sets };
}

function evaluate(vector: Vector): Outcome {
  const scan = scanSources(loadVectorSource(vector));
  const fail = (detail: string): Outcome => ({ vector, template: null, rules: [], pass: false, detail });

  if (scan.errors.length > 0) {
    return fail(scan.errors.map((e) => `${e.contract}: ${e.error}`).join("; "));
  }

  const hits = vector.contract ? scan.verifiers.filter((h) => h.contract === vector.contract) : scan.verifiers;
  if (hits.length > 1) return fail(`검증기가 ${hits.length}개 — manifest에 contract를 지정해야 함`);

  const hit = hits[0];
  const template = hit?.template ?? null;
  const rules = hit ? applyRules(hit.vk) : [];
  const pass = template === vector.expect.template && sameSet(rules, vector.expect.rules);

  const details: string[] = [];
  if (!hit && scan.unclassified.length > 0) {
    details.push(`수동 검토: ${scan.unclassified.map((u) => `${u.contract}(${u.reason})`).join(", ")}`);
  }
  if (hit) details.push(...hit.notes);
  if (!pass) details.push(`기대 ${vector.expect.template ?? "미분류"} [${vector.expect.rules.join(",")}]`);
  return { vector, template, rules, pass, detail: details.join("; ") };
}

const sameSet = (a: RuleId[], b: RuleId[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

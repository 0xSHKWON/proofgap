// manifest.json의 모든 벡터를 분류 → 추출 → 규칙 판정에 넣고 기대 결과와 비교한다.
// bytecodeVectors는 소스 없이 바이트코드 판정만 확인한다.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyRules, RULES, type RuleId } from "../rules/index.ts";
import { analyzeBytecode } from "../scanner/bytecode.ts";
import { scanSources, type TemplateId } from "../scanner/extract.ts";
import { loadBytecodeVectors, loadManifest, loadVectorSource, ROOT, type Vector } from "./manifest.ts";

type Outcome = {
  vector: Vector;
  template: TemplateId | null;
  rules: RuleId[];
  pass: boolean;
  detail: string;
};

export function checkTestVectors(): boolean {
  const outcomes = loadManifest().map(evaluate);

  for (const o of outcomes) {
    const mark = o.pass ? "PASS" : "FAIL";
    const got = `${o.template ?? "미분류"} [${o.rules.join(",")}]`;
    console.log(`${mark}  ${o.vector.id.padEnd(34)} ${o.vector.set.padEnd(18)} ${got}${o.detail ? `  — ${o.detail}` : ""}`);
  }

  console.log("\n규칙별 혼동 행렬 (분류된 벡터만)");
  for (const rule of RULES) {
    const m = { tp: 0, fp: 0, fn: 0, tn: 0 };
    for (const o of outcomes) {
      if (o.template === null) continue;
      const expected = o.vector.expect.rules.includes(rule.id);
      const actual = o.rules.includes(rule.id);
      m[expected ? (actual ? "tp" : "fn") : actual ? "fp" : "tn"]++;
    }
    console.log(`  ${rule.id} ${rule.title.padEnd(26)} TP ${m.tp}  FP ${m.fp}  FN ${m.fn}  TN ${m.tn}`);
  }

  console.log("\n바이트코드 판정");
  let bcFailed = 0;
  const bcVectors = loadBytecodeVectors();
  for (const v of bcVectors) {
    const { verdict } = analyzeBytecode(readFileSync(join(ROOT, v.path), "utf8").trim());
    const pass = verdict === v.expect;
    if (!pass) bcFailed++;
    console.log(`${pass ? "PASS" : "FAIL"}  ${v.id.padEnd(40)} ${verdict}${pass ? "" : `  — 기대 ${v.expect}`}`);
  }

  const failed = outcomes.filter((o) => !o.pass).length;
  const total = outcomes.length + bcVectors.length;
  console.log(`\n${total - failed - bcFailed}/${total} 통과`);
  return failed + bcFailed === 0;
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

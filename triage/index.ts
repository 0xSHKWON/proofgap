// 단계 3: 트리아지. 탐지 결과와 노출 확인 결과를 합쳐 우선순위를 매기고,
// 연락처 후보를 찾고, 비공개 제보 초안을 만든다. 절차는 docs/disclosure.md.
// 결과는 data/triage/에만 둔다. 실제 제보는 사람이 보낸다.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadExposure, type ExposureRecord } from "../exposure/index.ts";
import type { G2 } from "../lib/bn254.ts";
import { type Chain, fetchContract } from "../scanner/fetch.ts";
import { scanSources } from "../scanner/extract.ts";
import { loadResults } from "../scanner/scan.ts";
import { DATA_DIR, readJson, writeJson } from "../scanner/store.ts";
import { loadManifest } from "../testvectors/manifest.ts";
import { type Contact, findContacts } from "./contacts.ts";

export type Priority = "P0" | "P1" | "P2" | "known";
export type Status = "new" | "contact-found" | "reported" | "acknowledged" | "fixed" | "public" | "wontfix";

export type TriageItem = {
  chain: Chain;
  verifier: string;
  name: string | null;
  priority: Priority;
  reason: string;
  totalUsd: number;
  contacts: (Contact & { address: string })[];
  // 아래는 사람이 갱신한다. 다시 돌려도 덮어쓰지 않는다.
  status: Status;
  statusUpdatedAt: string | null;
  notes: string;
  firstSeen: string;
};

const triagePath = (chain: Chain) => join(DATA_DIR, "triage", `${chain}.json`);
export const loadTriage = (chain: Chain) => readJson<Record<string, TriageItem>>(triagePath(chain), {});

// 이미 공개 분석이 나온 사고. 호출자 이름이나 테스트 벡터의 알려진 양성으로 알아본다.
const KNOWN_INCIDENT_CALLERS = [/^FoomLottery$/, /^Veil_/, /^VEIL_/];

function isKnownIncident(e: ExposureRecord, knownVerifiers: Set<string>): boolean {
  return (
    knownVerifiers.has(`${e.chain}:${e.verifier}`) ||
    e.callers.some((c) => c.name && KNOWN_INCIDENT_CALLERS.some((re) => re.test(c.name as string)))
  );
}

function prioritize(e: ExposureRecord, known: boolean): { priority: Priority; reason: string } {
  if (known) return { priority: "known", reason: "공개된 사고" };
  if (e.level === "있음") return { priority: "P0", reason: `호출자 자산 $${e.totalUsd.toFixed(0)}` };
  if (e.level === "미미") return { priority: "P1", reason: `자산은 미미($${e.totalUsd.toFixed(2)})하지만 운영 중인 호출자가 있음` };
  return { priority: "P2", reason: e.level === "호출자 없음" ? "호출자를 찾지 못함" : "호출자 자산 없음" };
}

export async function runTriage(chain: Chain, opts: { log: (s: string) => void }): Promise<void> {
  const exposure = loadExposure(chain);
  const prev = loadTriage(chain);
  const knownVerifiers = new Set(
    loadManifest()
      .filter((v) => v.set === "known-positive" && v.source.kind === "onchain")
      .map((v) => (v.source.kind === "onchain" ? `${v.source.chain}:${v.source.address.toLowerCase()}` : "")),
  );
  const out: Record<string, TriageItem> = {};
  for (const e of Object.values(exposure)) {
    const { priority, reason } = prioritize(e, isKnownIncident(e, knownVerifiers));
    const old = prev[e.verifier];
    // 공개된 사고는 연락처를 찾지 않는다.
    const contacts = priority === "known" ? [] : old?.contacts ?? (await collectContacts(chain, e));
    out[e.verifier] = {
      chain,
      verifier: e.verifier,
      name: e.name,
      priority,
      reason,
      totalUsd: e.totalUsd,
      contacts,
      status: old?.status ?? (contacts.length ? "contact-found" : "new"),
      statusUpdatedAt: old?.statusUpdatedAt ?? null,
      notes: old?.notes ?? "",
      firstSeen: old?.firstSeen ?? new Date().toISOString(),
    };
  }
  writeJson(triagePath(chain), out);
  opts.log(`[${chain}] 트리아지 ${Object.keys(out).length}건 저장 (${triagePath(chain)})`);
}

async function collectContacts(chain: Chain, e: ExposureRecord): Promise<TriageItem["contacts"]> {
  const out: TriageItem["contacts"] = [];
  for (const address of [e.verifier, ...e.callers.map((c) => c.address)]) {
    const { source } = await fetchContract(chain, address).catch(() => ({ source: null }));
    if (!source) continue;
    for (const c of findContacts(source.files)) out.push({ ...c, address });
  }
  return out;
}

const ORDER: Priority[] = ["P0", "P1", "P2", "known"];

export function printTriage(chain: Chain): void {
  const items = Object.values(loadTriage(chain)).sort(
    (a, b) => ORDER.indexOf(a.priority) - ORDER.indexOf(b.priority) || b.totalUsd - a.totalUsd,
  );
  console.log(`[${chain}] 트리아지 ${items.length}건 — 비공개`);
  for (const p of ORDER) console.log(`  ${p.padEnd(6)} ${items.filter((i) => i.priority === p).length}`);
  for (const i of items.filter((i) => i.priority !== "known")) {
    console.log(`\n${i.priority}  ${i.verifier}  ${i.name ?? "-"}  [${i.status}]  ${i.reason}`);
    for (const c of i.contacts) console.log(`    연락처 후보 (${c.kind}) ${c.value}  ← ${c.address} ${c.file}`);
    if (i.contacts.length === 0) console.log("    연락처 후보 없음 — docs/disclosure.md의 연락처 찾기 순서 2~5를 사람이 확인");
  }
}

// ── 제보 초안 ────────────────────────────────────────────────

const fmtG2 = (p: G2) => `x = (${p.x.re}, ${p.x.im})\n    y = (${p.y.re}, ${p.y.im})`;
const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export async function writeDraft(chain: Chain, verifier: string): Promise<string> {
  const v = verifier.toLowerCase();
  const scan = loadResults(chain)[v];
  const exposure = loadExposure(chain)[v];
  if (!scan || scan.status !== "detected") throw new Error(`${chain}:${v}는 탐지된 검증기가 아님`);
  if (!exposure) throw new Error(`${chain}:${v}의 노출 확인 결과가 없음. proofgap exposure를 먼저 돌릴 것`);

  // 검증키는 저장하지 않으므로 소스에서 다시 뽑는다.
  const { source } = await fetchContract(chain, v);
  if (!source) throw new Error(`${chain}:${v}의 소스를 다시 받지 못함`);
  const main = scan.verifiers.find((x) => x.main);
  const hit = scanSources(source.files).verifiers.find((h) => h.contract === main?.contract);
  if (!main || !hit) throw new Error(`${chain}:${v}에서 검증기를 다시 찾지 못함`);
  const rules = main.rules;

  const callers = exposure.callers.length
    ? exposure.callers
        .map((c) => {
          const p = c.permissions;
          const perm = [
            p.proxy ? `업그레이드 가능 프록시 (구현 ${p.proxy.implementation ?? "?"})` : null,
            p.paused === null ? null : p.paused ? "현재 정지됨" : "정지 기능 있음 (현재 동작 중)",
            p.owner ? `owner ${p.owner.address} (${p.owner.kind}${p.owner.name ? `, ${p.owner.name}` : ""})` : null,
            p.adminFunctions.length ? `관리 함수: ${p.adminFunctions.join(", ")}` : null,
          ].filter(Boolean);
          return `- ${c.address} ${c.name ?? ""}\n  - 잔고 ${usd(c.assets.totalUsd)} (${c.assets.takenAt} 기준)${perm.map((x) => `\n  - ${x}`).join("")}`;
        })
        .join("\n")
    : "- 찾지 못함 (호출 내역, 배포자가 만든 컨트랙트, 바이트코드 참조를 확인함)";

  const md = `# [비공개] Groth16 검증기 셋업 누락 — ${chain} ${v}

> 이 초안은 proofgap이 만들었다. 보내기 전에 사람이 사실관계를 확인할 것.
> 공격 절차나 위조 증명은 포함하지 않는다.

## 요약

${chain}의 Groth16 검증기 \`${v}\` (${scan.name ?? "이름 없음"})의 검증키는 γ와 δ가 같고, 둘 다 BN254 G2 생성원이다.
snarkjs는 γ를 생성원으로 고정하고 Phase 2(회로별 기여)에서 δ만 무작위화한다. δ가 생성원으로 남았다는 것은
Phase 2 기여 없이 검증키를 만들었다는 뜻이며, 이 경우 검증기는 증명의 건전성을 보장하지 못한다.
같은 결함으로 2026년 2월 Base의 Veil과 Foom이 피해를 입었다.

## 근거

- 템플릿: ${hit.template}
- 걸린 규칙: ${rules.join(", ")} (R1: γ == δ, R2: δ == G2 생성원)
- γ:
    ${fmtG2(hit.vk.gamma)}
- δ:
    ${fmtG2(hit.vk.delta)}

검증기의 검증된 소스에서 위 상수를 직접 확인할 수 있다.

## 이 검증기를 믿는 컨트랙트

${callers}

## 권장 조치

1. 검증기를 믿는 컨트랙트의 입금·출금을 멈춘다 (정지 기능이 있다면 정지).
2. Phase 2 세레모니(기여 1회 이상 + 비컨)를 거친 zkey로 검증기를 다시 생성해 배포한다.
3. 호출자 컨트랙트의 검증기 주소를 교체한다. 교체 수단이 없다면 새 컨트랙트로 이전한다.
4. 조치가 끝나면 알려 주기 바란다. 90일 유예 뒤 또는 조치 완료 뒤에 개별 공개할 수 있다.

## 참고

- https://blog.zksecurity.xyz/posts/groth16-setup-exploit/
- https://rekt.news/the-unfinished-proof
`;
  const dir = join(DATA_DIR, "triage", "drafts");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${chain}-${v}.md`);
  writeFileSync(file, md);
  return file;
}

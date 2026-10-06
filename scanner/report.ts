// 스캔 결과 요약. 탐지·미분류 목록에는 개별 주소가 들어가므로 로컬에서만 본다.

import type { Chain } from "./fetch.ts";
import { loadResults, type ScanStatus } from "./scan.ts";
import { loadCandidates } from "./store.ts";

const ORDER: ScanStatus[] = [
  "detected",
  "bytecode-detected",
  "embedded",
  "error",
  "unclassified",
  "clean",
  "proxy",
  "not-verifier",
  "unverified",
];

export function printReport(chain: Chain): void {
  const candidates = loadCandidates(chain);
  const records = Object.values(loadResults(chain));

  const via = new Map<string, number>();
  for (const c of Object.values(candidates)) {
    for (const v of c.via) {
      const key = v.startsWith("impl-of:") ? "impl-of" : v;
      via.set(key, (via.get(key) ?? 0) + 1);
    }
  }
  console.log(`[${chain}] 후보 ${Object.keys(candidates).length}개, 스캔 ${records.length}개`);
  console.log(`  경로별: ${[...via].map(([k, n]) => `${k} ${n}`).join(", ")}`);

  console.log("\n상태별");
  for (const s of ORDER) console.log(`  ${s.padEnd(13)} ${records.filter((r) => r.status === s).length}`);

  const templates = new Map<string, number>();
  for (const r of records) for (const v of r.verifiers) templates.set(v.template, (templates.get(v.template) ?? 0) + 1);
  console.log(`\n템플릿별 검증기: ${[...templates].map(([k, n]) => `${k} ${n}`).join(", ") || "없음"}`);

  type Row = (typeof records)[number];
  const show = (status: ScanStatus, title: string, line: (r: Row) => string, only: (r: Row) => boolean = () => true) => {
    const rows = records.filter((r) => r.status === status && only(r));
    if (rows.length === 0) return;
    console.log(`\n${title} (${rows.length})`);
    for (const r of rows) console.log(`  ${r.address}  ${r.name ?? "-"}  ${line(r)}`);
  };
  show(
    "detected",
    "탐지 — 비공개. 공개 전에 docs/disclosure.md 절차를 따를 것",
    (r) =>
      r.verifiers
        .filter((v) => v.main && v.rules.length)
        .map((v) => `${v.contract}[${v.rules.join(",")}]`)
        .join(" ") + (r.verifiedTwin ? ` (twin ${r.verifiedTwin}의 소스로 판정 — 바이트코드 확인 필요)` : ""),
  );
  show("embedded", "소스에만 포함된 탐지 검증기 — 이 컨트랙트가 실제로 호출하는 검증기 주소를 따로 확인할 것", (r) =>
    r.verifiers
      .filter((v) => v.rules.length)
      .map((v) => `${v.contract}[${v.rules.join(",")}]`)
      .join(" "),
  );
  show("bytecode-detected", "바이트코드 판정 탐지 (소스 미검증) — 비공개", (r) => `G2 점 ${r.bytecode?.g2Points}`);
  show(
    "unverified",
    "바이트코드 판정 의심 — 옵티마이저가 상수를 합쳤거나 δ가 상수로 없음. 사람이 확인",
    (r) => `G2 점 ${r.bytecode?.g2Points}`,
    (r) => r.bytecode?.verdict === "suspect",
  );
  const mismatch = records.filter(
    (r) =>
      r.g2GenCount !== null &&
      ((r.status === "detected" && r.g2GenCount < 2) || (r.status === "clean" && r.g2GenCount >= 2)),
  );
  if (mismatch.length > 0) {
    console.log(`\n소스 판정과 바이트코드 신호가 어긋남 — twin 소스이거나 컴파일러가 상수를 합쳤을 수 있음 (${mismatch.length})`);
    for (const r of mismatch) console.log(`  ${r.address}  ${r.name ?? "-"}  ${r.status} g2GenCount=${r.g2GenCount}`);
  }
  show("error", "추출·수집 실패", (r) => r.errors.join("; "));
  show("unclassified", "미분류 — 수동 검토 대기열", (r) => r.unclassified.map((u) => `${u.contract}(${u.reason})`).join(", "));
}

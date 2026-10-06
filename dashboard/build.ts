// 대시보드 HTML 생성. 외부 의존성 없이 한 파일로 만든다.
//   data/dashboard/internal.html   내부용. 개별 주소 포함. 커밋하지 않음
//   docs/stats/index.html          공개용. GitHub Pages로 공개. 집계 숫자, 판정 정확도, 공개된 사고, 방법과 한계
//   docs/stats/stats.json
// 공개용에는 이미 공개 분석이 나온 사고(Veil, Foom)의 주소만 들어간다. 미공개 탐지·의심·R3 주소가
// 하나라도 섞이면 assertNoPrivateAddresses가 생성을 멈춘다.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../scanner/store.ts";
import { ROOT } from "../testvectors/manifest.ts";
import {
  assertNoPrivateAddresses,
  type ChainStats,
  collectStats,
  type InternalStats,
  type PublicStats,
  toPublic,
} from "./stats.ts";

const OUT = join(DATA_DIR, "dashboard");
const PUBLIC_OUT = join(ROOT, "docs", "stats");

// 체인별 후보 수집 경로와 한계 (README 커버리지 표와 같은 내용)
const COVERAGE: Record<string, string> = {
  ethereum: "BigQuery로 전체 바이트코드에서 G2 생성원 검색 (소스 미검증 포함, 데이터셋 당일 갱신)",
  base: "검증 컨트랙트 이름 검색 + 최근 3주 페어링 프리컴파일 호출자. 이름을 바꾼 소스 미검증 검증기는 놓칠 수 있음",
  arbitrum: "검증 컨트랙트 이름 검색 + 최근 7일 페어링 프리컴파일 호출자",
  optimism: "검증 컨트랙트 이름 검색 + 최근 7일 페어링 프리컴파일 호출자",
  polygon: "BigQuery 바이트코드 검색(2024-09까지) + 검증 컨트랙트 이름 검색. Blockscout 호출 기록은 2024-10 이후 없음",
};

const CHAIN_LABEL: Record<string, string> = {
  ethereum: "Ethereum",
  base: "Base",
  arbitrum: "Arbitrum",
  optimism: "Optimism",
  polygon: "Polygon",
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (n: number) => n.toLocaleString("en-US");
const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

// ── 스타일: dataviz 기본 팔레트 (단일 계열 blue, 상태색은 아이콘·라벨과 함께) ──
const STYLE = `
.viz-root{color-scheme:light;--page:#f9f9f7;--surface-1:#fcfcfb;--text-primary:#0b0b0b;--text-secondary:#52514e;--muted:#898781;
--grid:#e1e0d9;--axis:#c3c2b7;--border:rgba(11,11,11,.10);--series-1:#2a78d6;--critical:#d03b3b;--good:#0ca30c}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;--page:#0d0d0d;--surface-1:#1a1a19;
--text-primary:#fff;--text-secondary:#c3c2b7;--grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);--series-1:#3987e5}}
:root[data-theme="dark"] .viz-root{color-scheme:dark;--page:#0d0d0d;--surface-1:#1a1a19;--text-primary:#fff;--text-secondary:#c3c2b7;
--grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);--series-1:#3987e5}
body{margin:0}
.viz-root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--page);color:var(--text-primary);min-height:100vh;padding:32px;box-sizing:border-box}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 12px}
.sub{color:var(--text-secondary);font-size:13px;margin:0 0 24px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.tile{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;padding:16px}
.tile .v{font-size:28px;font-weight:600;margin-top:6px}.tile .k{color:var(--text-secondary);font-size:13px}
.card{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;padding:16px;margin-top:12px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:12px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:6px 10px;text-align:left;border-bottom:1px solid var(--grid)}
th{color:var(--text-secondary);font-weight:500}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
code{font-size:12px}.muted{color:var(--muted)}
.status{display:inline-flex;align-items:center;gap:4px}.status::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--muted)}
.status.critical::before{background:var(--critical)}.status.good::before{background:var(--good)}
svg text{fill:var(--text-secondary);font-size:12px}svg .val{fill:var(--text-primary)}
.bar{fill:var(--series-1)}.hit{fill:transparent}.row:hover .bar{opacity:.85}
#tip{position:fixed;pointer-events:none;background:var(--surface-1);border:1px solid var(--border);border-radius:8px;padding:6px 10px;font-size:12px;display:none;box-shadow:0 2px 8px rgba(0,0,0,.12)}
details summary{cursor:pointer;color:var(--text-secondary);font-size:13px}`;

const TIP_SCRIPT = `<div id="tip"></div><script>
const tip=document.getElementById("tip");
document.querySelectorAll("[data-tip]").forEach(el=>{
  el.addEventListener("mousemove",e=>{tip.textContent=el.dataset.tip;tip.style.display="block";tip.style.left=(e.clientX+12)+"px";tip.style.top=(e.clientY+12)+"px"});
  el.addEventListener("mouseleave",()=>{tip.style.display="none"});
});</script>`;

// 가로 막대 (단일 계열). 막대는 24px 이하, 기준선 쪽은 각지고 끝은 4px 둥글게. 값은 막대 끝에 텍스트 색으로.
function barChart(title: string, unit: string, rows: { label: string; value: number }[]): string {
  const W = 520;
  const labelW = 90;
  const valueW = 60;
  const rowH = 32;
  const barH = 20;
  const max = Math.max(1, ...rows.map((r) => r.value));
  const plotW = W - labelW - valueW;
  const body = rows
    .map((r, i) => {
      const y = i * rowH;
      const w = r.value === 0 ? 0 : Math.max(4, (r.value / max) * plotW);
      const rr = Math.min(4, w);
      const by = y + (rowH - barH) / 2;
      const path =
        w === 0
          ? ""
          : `<path class="bar" d="M${labelW},${by} h${w - rr} a${rr},${rr} 0 0 1 ${rr},${rr} v${barH - 2 * rr} a${rr},${rr} 0 0 1 -${rr},${rr} h-${w - rr} z"/>`;
      return `<g class="row" data-tip="${esc(`${r.label}: ${num(r.value)}${unit}`)}">
<rect class="hit" x="0" y="${y}" width="${W}" height="${rowH}"/>
<text x="${labelW - 10}" y="${y + rowH / 2 + 4}" text-anchor="end">${esc(r.label)}</text>${path}
<text class="val" x="${labelW + w + 6}" y="${y + rowH / 2 + 4}">${num(r.value)}</text></g>`;
    })
    .join("");
  const h = rows.length * rowH;
  return `<div class="card"><div style="font-weight:600;font-size:14px">${esc(title)}</div>
<svg viewBox="0 0 ${W} ${h + 8}" width="100%" role="img" aria-label="${esc(title)}">
<line x1="${labelW}" y1="0" x2="${labelW}" y2="${h}" stroke="var(--axis)" stroke-width="1"/>${body}</svg></div>`;
}

function chainTable(chains: ChainStats[], materialUsd: number): string {
  const total = (k: keyof ChainStats) => chains.reduce((s, c) => s + (c[k] as number), 0);
  const row = (c: ChainStats) =>
    `<tr><td>${CHAIN_LABEL[c.chain] ?? c.chain}</td><td class="n">${num(c.candidates)}</td><td class="n">${num(c.verifiers)}</td>
<td class="n">${num(c.detected)}</td><td class="n">${num(c.r3)}</td><td class="n">${num(c.suspect)}</td><td class="n">${num(c.material)}</td></tr>`;
  return `<div class="card"><table><thead><tr><th>체인</th><th class="n">수집한 후보</th><th class="n">Groth16 검증기</th>
<th class="n">R1·R2 탐지</th><th class="n">R3 해당</th><th class="n">의심 (확인 대기)</th><th class="n">자산 ${usd(materialUsd)} 이상 노출</th></tr></thead>
<tbody>${chains.map(row).join("")}<tr><td><b>합계</b></td><td class="n"><b>${num(total("candidates"))}</b></td><td class="n"><b>${num(total("verifiers"))}</b></td>
<td class="n"><b>${num(total("detected"))}</b></td><td class="n"><b>${num(total("r3"))}</b></td><td class="n"><b>${num(total("suspect"))}</b></td><td class="n"><b>${num(total("material"))}</b></td></tr></tbody></table></div>`;
}

function overview(s: PublicStats): string {
  const sum = (k: keyof ChainStats) => s.chains.reduce((a, c) => a + (c[k] as number), 0);
  const material = sum("material");
  const tiles = [
    ["체인", num(s.chains.length)],
    ["수집한 후보", num(sum("candidates"))],
    ["Groth16 검증기", num(sum("verifiers"))],
    ["R1·R2 탐지", num(sum("detected"))],
    ["R3 묶음", num(s.r3Groups)],
  ]
    .map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join("");
  const exposureTile = `<div class="tile"><div class="k">자산 ${usd(s.materialUsd)} 이상 노출</div><div class="v">${num(material)}</div>
<div class="status ${material ? "critical" : "good"}" style="font-size:12px;margin-top:4px">${material ? "제보 필요" : "없음"}</div></div>`;
  const rows = (k: keyof ChainStats) => s.chains.map((c) => ({ label: CHAIN_LABEL[c.chain] ?? c.chain, value: c[k] as number }));
  return `<div class="tiles">${tiles}${exposureTile}</div>
<div class="grid2">${barChart("체인별 Groth16 검증기", "개", rows("verifiers"))}${barChart("체인별 R1·R2 탐지", "건", rows("detected"))}</div>
<h2>체인별 수치</h2>${chainTable(s.chains, s.materialUsd)}`;
}

function page(title: string, sub: string, body: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head><body><div class="viz-root"><h1>${esc(title)}</h1><p class="sub">${sub}</p>${body}</div>${TIP_SCRIPT}</body></html>`;
}

function internalSections(s: InternalStats): string {
  const det = s.detections
    .map(
      (d) => `<tr><td>${CHAIN_LABEL[d.chain]}</td><td><code>${d.address}</code></td><td>${esc(d.name ?? "-")}</td><td>${d.via}</td>
<td>${esc(d.priority)}</td><td>${esc(d.status)}</td><td>${esc(d.level)}</td><td class="n">${usd(d.totalUsd)}</td><td class="n">${d.callers}</td></tr>`,
    )
    .join("");
  const r3 = s.r3
    .map(
      (g) => `<div class="card"><div>δ <code>${g.delta.slice(0, 16)}…</code> — 회로 ${g.circuits}개, 검증기 ${g.members.length}개</div>
<ul>${g.members.map((m) => `<li><code>${esc(m)}</code></li>`).join("")}</ul></div>`,
    )
    .join("");
  const sus = s.suspects.map((x) => `<li>${CHAIN_LABEL[x.chain]} <code>${x.address}</code></li>`).join("");
  return `<h2>탐지 목록 (${s.detections.length})</h2><div class="card" style="overflow-x:auto"><table><thead><tr><th>체인</th><th>주소</th><th>이름</th>
<th>판정</th><th>우선순위</th><th>상태</th><th>노출</th><th class="n">자산</th><th class="n">호출자</th></tr></thead><tbody>${det}</tbody></table></div>
<h2>R3 묶음 (${s.r3.length})</h2>${r3 || '<p class="muted">없음</p>'}
<h2>바이트코드 의심 (${s.suspects.length})</h2><div class="card"><details><summary>펼치기</summary><ul>${sus}</ul></details></div>`;
}

function publicSections(s: PublicStats): string {
  const a = s.accuracy;
  const tv = a.testVectors;
  const tile = (k: string, v: string, note = "") =>
    `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div>${note ? `<div class="muted" style="font-size:12px;margin-top:4px">${note}</div>` : ""}</div>`;
  const accuracy = `<h2>판정 정확도</h2>
<p class="sub">소스가 검증된 검증기는 소스로 판정하고(정답), 같은 검증기를 바이트코드만으로 다시 판정해 비교했다.
소스가 없는 컨트랙트는 바이트코드 판정만 쓴다. 기준은 <a href="https://github.com/0xSHKWON/proofgap/blob/main/docs/rules.md">docs/rules.md</a>.</p>
<div class="tiles">${
    a.labeled === 0
      ? tile("바이트코드 정확도", "확인 전", "proofgap bytecode check를 먼저 실행")
      : `${tile("대조한 검증기", num(a.labeled))}${tile("오탐", num(a.falsePositive), "소스 정상 → 바이트코드 탐지")}
${tile("놓침", num(a.falseNegative), "소스 탐지 → 바이트코드 정상·Groth16 아님")}`
  }${tile("의심으로 넘어간 탐지", num(a.suspect), "옵티마이저가 상수를 합치거나 데이터 영역으로 옮긴 경우")}
${tile("테스트 벡터", `${num(tv.passed)}/${num(tv.total)}`, "합성·실제 양성·음성, 바이트코드, R3")}</div>`;

  const knownRows = s.known
    .map(
      (k) => `<tr><td>${CHAIN_LABEL[k.chain]}</td><td><code>${k.verifier}</code></td><td>${esc(k.name ?? "-")}</td>
<td>${k.callers.map((c) => `<code>${c.address}</code> ${esc(c.name ?? "")}`).join("<br>") || '<span class="muted">-</span>'}</td></tr>`,
    )
    .join("");
  const known = `<h2>공개된 사고 (${s.known.length})</h2>
<p class="sub">이미 공개 분석이 나온 사고만 개별 주소를 싣는다 (2026년 2월 Veil, Foom). 그 밖의 탐지 건은 주소를 공개하지 않는다.</p>
<div class="card" style="overflow-x:auto"><table><thead><tr><th>체인</th><th>검증기</th><th>이름</th><th>이 검증기를 믿는 컨트랙트</th></tr></thead>
<tbody>${knownRows}</tbody></table></div>`;

  const coverage = `<h2>방법과 한계</h2><div class="card"><table><thead><tr><th>체인</th><th>후보 수집 경로와 한계</th></tr></thead><tbody>
${s.chains.map((c) => `<tr><td>${CHAIN_LABEL[c.chain]}</td><td>${esc(COVERAGE[c.chain] ?? "-")}</td></tr>`).join("")}
<tr><td>BNB</td><td>무료로 후보를 모을 경로가 없어 제외</td></tr></tbody></table>
<ul style="font-size:13px;line-height:1.7;margin-top:12px">
<li>규칙: R1(γ == δ), R2(δ == G2 생성원), R3(같은 δ를 서로 다른 회로가 재사용). R4(공개 입력 범위 검사)는 보류.</li>
<li>"의심"은 바이트코드만으로는 결론이 나지 않는 검증기다. 옵티마이저가 같은 상수를 합친 결함일 수도, δ를 스토리지에서 읽는 정상 검증기일 수도 있다.</li>
<li>자산 노출은 검증기를 호출하는 컨트랙트의 네이티브 코인과 시세 있는 토큰 잔고를 합한 값이다. 호출자를 못 찾았다고 호출자가 없다는 뜻은 아니다.</li>
<li>메인넷에 트랜잭션을 보내지 않고, 위조 증명을 만들지 않는다. 절차는 <a href="https://github.com/0xSHKWON/proofgap/blob/main/docs/disclosure.md">docs/disclosure.md</a>.</li>
</ul></div>`;
  return accuracy + known + coverage;
}

export function buildDashboard(opts: { log: (s: string) => void }): void {
  const stats = collectStats();
  const pub = toPublic(stats);
  const when = new Date(stats.generatedAt).toISOString().slice(0, 10);
  mkdirSync(OUT, { recursive: true });
  mkdirSync(PUBLIC_OUT, { recursive: true });

  writeFileSync(
    join(OUT, "internal.html"),
    page(
      "proofgap 내부 대시보드",
      `${when} 기준 · 비공개 — 개별 주소가 들어 있으니 공유하지 말 것. 절차는 docs/disclosure.md`,
      overview(pub) + publicSections(pub) + internalSections(stats),
    ),
  );
  const publicHtml = page(
    "proofgap 스캔 통계",
    `${when} 기준 · Groth16 검증기 셋업 누락(γ == δ) 스캔 결과. 공개된 사고 외의 개별 주소는 싣지 않는다. ` +
      `<a href="https://github.com/0xSHKWON/proofgap">github.com/0xSHKWON/proofgap</a>`,
    overview(pub) + publicSections(pub),
  );
  const publicJson = JSON.stringify(pub, null, 2) + "\n";
  assertNoPrivateAddresses(stats, publicHtml + publicJson);
  writeFileSync(join(PUBLIC_OUT, "index.html"), publicHtml);
  writeFileSync(join(PUBLIC_OUT, "stats.json"), publicJson);
  opts.log(`내부: ${join(OUT, "internal.html")}`);
  opts.log(`공개: ${join(PUBLIC_OUT, "index.html")} (+ stats.json) — 미공개 주소 없음 확인`);
}

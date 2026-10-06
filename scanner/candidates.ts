// 후보 수집. 경로마다 커버리지가 다르므로 어떤 경로로 찾았는지(via)를 같이 남긴다.
//
//   precompile  페어링 프리컴파일(0x08)을 호출한 컨트랙트. 실제로 쓰인 검증기만 잡힌다.
//               Blockscout가 오래된 구간에서 타임아웃이 나서 최근 기간만 안정적으로 훑을 수 있다.
//   name:<q>    Blockscout 검증 컨트랙트 이름 검색. 호출된 적 없는 검증기도 잡지만 이름을 바꾸면 놓친다.
//   bigquery    체인 전체 바이트코드에서 G2 생성원 상수를 찾은 결과 (이더리움, Polygon. scanner/sql/ 참고).

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Chain, CHAINS } from "./fetch.ts";
import { getJson } from "./http.ts";
import { addCandidate, DATA_DIR, loadCandidates, readJson, saveCandidates, writeJson } from "./store.ts";

const PAIRING_PRECOMPILE = "0x0000000000000000000000000000000000000008";

type PageParams = Record<string, string | number>;
type Page<T> = { items: T[]; next_page_params: PageParams | null };
type InternalTx = { block_number: number; timestamp: string; from: { hash: string; name: string | null } };

// 지금까지 훑은 블록 구간 [oldestBlock, newestBlock]. 다음 실행은 위(새 블록)와 아래(더 과거)를 이어서 훑는다.
type CrawlState = {
  newestBlock: number;
  oldestBlock: number;
  oldestTime: string;
  cursor: PageParams | null; // 더 과거로 이어갈 커서
};

const statePath = (chain: Chain) => join(DATA_DIR, "state", `${chain}.precompile.json`);

export async function crawlPrecompile(chain: Chain, opts: { days: number; log: (s: string) => void }): Promise<void> {
  const base = `${CHAINS[chain].blockscout}/api/v2/addresses/${PAIRING_PRECOMPILE}/internal-transactions`;
  const url = (p: PageParams | null) => (p ? `${base}?${new URLSearchParams(p as Record<string, string>)}` : base);
  const since = new Date(Date.now() - opts.days * 86_400_000).toISOString();
  const set = loadCandidates(chain);
  const prev = readJson<CrawlState | null>(statePath(chain), null);
  let found = 0;

  const take = (items: InternalTx[]) => {
    for (const it of items) {
      const c = addCandidate(set, it.from.hash, "precompile", it.from.name);
      if (c.precompileCalls === undefined) found++;
      c.precompileCalls = (c.precompileCalls ?? 0) + 1;
    }
  };

  // 1) 최신 블록에서 내려오면서 지난번에 훑은 구간을 만날 때까지 (첫 실행이면 첫 페이지만)
  let page = await getJson<Page<InternalTx>>(url(null));
  const newestBlock = page.items[0]?.block_number ?? prev?.newestBlock ?? 0;
  let state: CrawlState;
  if (prev) {
    state = prev;
    for (;;) {
      const fresh = page.items.filter((it) => it.block_number > prev.newestBlock);
      take(fresh);
      if (fresh.length < page.items.length || !page.next_page_params) break;
      page = await getJson<Page<InternalTx>>(url(page.next_page_params));
    }
  } else {
    take(page.items);
    const last = page.items.at(-1);
    state = {
      newestBlock,
      oldestBlock: last?.block_number ?? newestBlock,
      oldestTime: last?.timestamp ?? new Date().toISOString(),
      cursor: page.next_page_params,
    };
  }
  state.newestBlock = newestBlock;
  saveCandidates(chain, set);
  writeJson(statePath(chain), state);

  // 2) 지난번에 멈춘 곳부터 since까지 더 과거로
  let pages = 0;
  while (state.cursor && state.oldestTime >= since) {
    try {
      page = await getJson<Page<InternalTx>>(url(state.cursor), { retries: 3, timeoutMs: 110_000 });
    } catch (e) {
      opts.log(`  ${state.oldestTime} 부근에서 중단: ${(e as Error).message}. 다시 실행하면 여기서 이어감`);
      break;
    }
    take(page.items);
    const last = page.items.at(-1);
    if (last) state = { ...state, oldestBlock: last.block_number, oldestTime: last.timestamp };
    state.cursor = page.next_page_params;
    if (++pages % 20 === 0) {
      saveCandidates(chain, set);
      writeJson(statePath(chain), state);
      opts.log(`  ${state.oldestTime}까지 훑음, 새 후보 ${found}개`);
    }
  }
  saveCandidates(chain, set);
  writeJson(statePath(chain), state);
  opts.log(`precompile: ${state.oldestTime} ~ 현재 (블록 ${state.oldestBlock}~${state.newestBlock}), 새 후보 ${found}개`);
}

type ContractListItem = { address: { hash: string; name: string | null } };

export async function searchByName(
  chain: Chain,
  opts: { terms: string[]; maxPages: number; log: (s: string) => void },
): Promise<void> {
  const set = loadCandidates(chain);
  for (const term of opts.terms) {
    let params: PageParams | null = { q: term };
    let pages = 0;
    let found = 0;
    while (params && pages < opts.maxPages) {
      let page: Page<ContractListItem>;
      try {
        const qs = new URLSearchParams(params as Record<string, string>);
        page = await getJson(`${CHAINS[chain].blockscout}/api/v2/smart-contracts?${qs}`, { timeoutMs: 110_000 });
      } catch (e) {
        opts.log(`  name:${term} ${pages}페이지에서 중단: ${(e as Error).message}`);
        break;
      }
      for (const it of page.items) {
        if (!set[it.address.hash.toLowerCase()]) found++;
        addCandidate(set, it.address.hash, `name:${term}`, it.address.name);
      }
      params = page.next_page_params;
      if (++pages % 20 === 0) {
        saveCandidates(chain, set);
        opts.log(`  name:${term} ${pages}페이지, 새 후보 ${found}개`);
      }
    }
    saveCandidates(chain, set);
    opts.log(`name:${term}: ${pages}페이지${params ? " (끝까지 못 감)" : ""}, 새 후보 ${found}개`);
  }
}

// 첫 줄이 헤더이고 address 열이 있는 CSV (bq query --format=csv 결과). g2_gen_count 열이 있으면 같이 저장한다.
export function importCsv(chain: Chain, file: string, via: string): number {
  const [header, ...rows] = readFileSync(file, "utf8").trim().split(/\r?\n/);
  const cols = header.split(",");
  const col = cols.indexOf("address");
  const countCol = cols.indexOf("g2_gen_count");
  if (col === -1) throw new Error(`${file}: address 열이 없음`);
  const set = loadCandidates(chain);
  let found = 0;
  for (const row of rows) {
    const cells = row.split(",");
    const address = cells[col]?.trim();
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) continue;
    if (!set[address.toLowerCase()]) found++;
    const c = addCandidate(set, address, via);
    if (countCol !== -1) c.g2GenCount = Number(cells[countCol]);
  }
  saveCandidates(chain, set);
  return found;
}

const BIGQUERY_SQL = join(new URL(".", import.meta.url).pathname, "sql", "g2_generator.sql");

// bq CLI로 쿼리를 돌린다. dryRun이면 처리할 바이트 수만 확인한다 (BigQuery 무료 한도는 월 1TB).
export function runBigQuery(chain: Chain, opts: { dryRun: boolean; log: (s: string) => void }): void {
  const table = CHAINS[chain].bigquery;
  if (!table) throw new Error(`${chain}: 바이트코드가 있는 BigQuery 공개 테이블이 없음`);
  // SQL이 -- 주석으로 시작하면 bq가 옵션으로 읽으므로 표준입력으로 넘긴다.
  const input = readFileSync(BIGQUERY_SQL, "utf8").replaceAll("{{table}}", table);
  const args = ["query", "--nouse_legacy_sql", "--format=csv", "--max_rows=10000000"];
  if (opts.dryRun) {
    const out = execFileSync("bq", [...args, "--dry_run"], { encoding: "utf8", input });
    const bytes = Number(out.trim().split(/\s+/).at(-1));
    opts.log(Number.isFinite(bytes) ? `처리량 ${(bytes / 1e9).toFixed(1)} GB (무료 한도 월 1 TB)` : out.trim());
    return;
  }
  const out = execFileSync("bq", args, { encoding: "utf8", input, maxBuffer: 1 << 30 });
  const file = join(DATA_DIR, "candidates", `${chain}.bigquery.csv`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, out);
  opts.log(`bigquery: ${importCsv(chain, file, "bigquery")}개 새 후보 (${file})`);
}

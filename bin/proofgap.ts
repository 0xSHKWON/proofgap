#!/usr/bin/env node
import { parseArgs } from "node:util";
import { crawlPrecompile, importCsv, runBigQuery, searchByName } from "../scanner/candidates.ts";
import { type Chain, isChain } from "../scanner/fetch.ts";
import { printReport } from "../scanner/report.ts";
import { scanAddress, scanCandidates, type ScanStatus } from "../scanner/scan.ts";
import { buildTestVectors } from "../testvectors/build.ts";
import { checkTestVectors } from "../testvectors/check.ts";

const USAGE = `사용법:
  proofgap testvectors build [--refresh]        합성 벡터 생성, 체인 벡터 소스 수집
  proofgap testvectors check                    모든 벡터를 판정하고 기대 결과와 비교

  proofgap candidates crawl  --chain C [--days 7]               페어링 프리컴파일 호출자 수집 (이어서 실행 가능)
  proofgap candidates search --chain C [--term Verifier] [--max-pages 200]   검증 컨트랙트 이름 검색
  proofgap candidates bigquery --chain ethereum [--dry-run]     바이트코드에서 G2 생성원 검색 (bq CLI 필요)
  proofgap candidates import --chain C --file F.csv [--via V]   address 열이 있는 CSV 가져오기

  proofgap scan --chain C --address 0x...       컨트랙트 하나 판정 (저장하지 않음)
  proofgap scan --chain C --all [--rescan [--status error,not-verifier]] [--concurrency 4]
                                                수집한 후보 전체 판정 (--status: 그 상태인 것만 다시 판정)
  proofgap report --chain C                     결과 요약, 탐지·미분류 목록

  C = ethereum | base. 수집·판정 결과는 data/에 저장되고 커밋되지 않는다.`;

const log = (s: string) => console.log(s);

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      chain: { type: "string" },
      address: { type: "string" },
      all: { type: "boolean", default: false },
      rescan: { type: "boolean", default: false },
      status: { type: "string" },
      concurrency: { type: "string", default: "4" },
      days: { type: "string", default: "7" },
      term: { type: "string", multiple: true },
      "max-pages": { type: "string", default: "200" },
      "dry-run": { type: "boolean", default: false },
      file: { type: "string" },
      via: { type: "string", default: "import" },
      refresh: { type: "boolean", default: false },
    },
  });
  const [cmd, sub] = positionals;

  if (cmd === "testvectors" && sub === "build") {
    await buildTestVectors({ refresh: values.refresh });
    return 0;
  }
  if (cmd === "testvectors" && sub === "check") return checkTestVectors() ? 0 : 1;

  const chain = values.chain;
  if (!chain || !isChain(chain)) {
    console.error(USAGE);
    return 2;
  }

  if (cmd === "candidates") return candidates(chain, sub, values);

  if (cmd === "scan" && values.address) {
    const r = await scanAddress(chain, values.address);
    console.log(JSON.stringify(r, null, 2));
    return r.status === "error" ? 1 : 0;
  }
  if (cmd === "scan" && values.all) {
    const statuses = values.status?.split(",") as ScanStatus[] | undefined;
    await scanCandidates(chain, { concurrency: Number(values.concurrency), rescan: values.rescan, statuses, log });
    printReport(chain);
    return 0;
  }
  if (cmd === "report") {
    printReport(chain);
    return 0;
  }
  console.error(USAGE);
  return 2;
}

async function candidates(
  chain: Chain,
  sub: string | undefined,
  values: { days: string; term?: string[]; "max-pages": string; "dry-run": boolean; file?: string; via: string },
): Promise<number> {
  switch (sub) {
    case "crawl":
      await crawlPrecompile(chain, { days: Number(values.days), log });
      return 0;
    case "search":
      await searchByName(chain, { terms: values.term ?? ["Verifier"], maxPages: Number(values["max-pages"]), log });
      return 0;
    case "bigquery":
      runBigQuery(chain, { dryRun: values["dry-run"], log });
      return 0;
    case "import":
      if (!values.file) break;
      log(`${importCsv(chain, values.file, values.via)}개 새 후보`);
      return 0;
  }
  console.error(USAGE);
  return 2;
}

// snarkjs가 띄운 워커 스레드가 남아 있어 프로세스가 끝나지 않으므로 직접 종료한다.
process.exit(await main(process.argv.slice(2)));

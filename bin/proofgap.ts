#!/usr/bin/env node
import { parseArgs } from "node:util";
import { crawlPrecompile, importCsv, runBigQuery, searchByName } from "../scanner/candidates.ts";
import { type Chain, isChain } from "../scanner/fetch.ts";
import { runBytecodeRefs } from "../exposure/bytecode-refs.ts";
import { checkExposure, printExposure, runExposure } from "../exposure/index.ts";
import { checkBytecode, scanBytecode } from "../scanner/bytecode-scan.ts";
import { printReport } from "../scanner/report.ts";
import { printTriage, runTriage, writeDraft } from "../triage/index.ts";
import { scanAddress, scanCandidates, type ScanStatus } from "../scanner/scan.ts";
import { buildTestVectors } from "../testvectors/build.ts";
import { checkTestVectors } from "../testvectors/check.ts";

const USAGE = `사용법:
  proofgap testvectors build [--refresh]        합성 벡터 생성, 체인 벡터 소스 수집
  proofgap testvectors check                    모든 벡터를 판정하고 기대 결과와 비교

  proofgap candidates crawl  --chain C [--days 7]               페어링 프리컴파일 호출자 수집 (이어서 실행 가능)
  proofgap candidates search --chain C [--term Verifier] [--max-pages 200]   검증 컨트랙트 이름 검색
  proofgap candidates bigquery --chain ethereum|polygon [--dry-run]   바이트코드에서 G2 생성원 검색 (bq CLI 필요)
  proofgap candidates import --chain C --file F.csv [--via V]   address 열이 있는 CSV 가져오기

  proofgap scan --chain C --address 0x...       컨트랙트 하나 판정 (저장하지 않음)
  proofgap scan --chain C --all [--rescan [--status error,not-verifier]] [--concurrency 4]
                                                수집한 후보 전체 판정 (--status: 그 상태인 것만 다시 판정)
  proofgap report --chain C                     결과 요약, 탐지·미분류 목록
  proofgap bytecode check --chain C             소스 판정이 있는 검증기로 바이트코드 판정 정확도 확인
  proofgap bytecode scan --chain C              소스 미검증 후보를 바이트코드로 판정

  proofgap exposure --chain C [--refresh]       탐지 전체의 호출자·잔고·권한 확인 후 요약 (확인한 건은 건너뜀)
  proofgap exposure --chain C --address 0x...   검증기 하나만 확인 (저장하지 않음)
  proofgap exposure --chain C --report          저장된 결과 요약만
  proofgap exposure refs --chain ethereum|polygon [--dry-run]   바이트코드에 검증기 주소가 있는 컨트랙트 (BigQuery)

  proofgap triage --chain C [--report]          탐지·노출 결과로 우선순위와 연락처 후보 정리 (docs/disclosure.md)
  proofgap triage draft --chain C --address 0x...   비공개 제보 초안 (data/triage/drafts/)

  C = ethereum | base | arbitrum | optimism | polygon. 수집·판정 결과는 data/에 저장되고 커밋되지 않는다.`;

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
      report: { type: "boolean", default: false },
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
  if (cmd === "exposure") {
    if (sub === "refs") {
      runBytecodeRefs(chain, { dryRun: values["dry-run"], log });
      return 0;
    }
    if (values.address) {
      console.log(JSON.stringify(await checkExposure(chain, values.address, null), null, 2));
    } else {
      if (!values.report) await runExposure(chain, { refresh: values.refresh, log });
      printExposure(chain);
    }
    return 0;
  }
  if (cmd === "triage") {
    if (sub === "draft" && values.address) {
      log(`초안: ${await writeDraft(chain, values.address)}`);
      return 0;
    }
    if (!values.report) await runTriage(chain, { log });
    printTriage(chain);
    return 0;
  }
  if (cmd === "bytecode" && sub === "check") {
    await checkBytecode(chain, { log });
    return 0;
  }
  if (cmd === "bytecode" && sub === "scan") {
    await scanBytecode(chain, { log });
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

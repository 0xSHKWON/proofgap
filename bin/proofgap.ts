#!/usr/bin/env node
import { buildTestVectors } from "../testvectors/build.ts";
import { checkTestVectors } from "../testvectors/check.ts";

const USAGE = `사용법:
  proofgap testvectors build [--refresh]   합성 벡터 생성, 체인 벡터 소스 수집 (--refresh: 이미 받은 소스도 다시 받음)
  proofgap testvectors check               모든 벡터를 판정하고 기대 결과와 비교
  proofgap scan ...                        (단계 1에서 구현 예정)`;

async function main(argv: string[]): Promise<number> {
  const [cmd, sub, ...rest] = argv;
  if (cmd === "testvectors" && sub === "build") {
    await buildTestVectors({ refresh: rest.includes("--refresh") });
    return 0;
  }
  if (cmd === "testvectors" && sub === "check") {
    return checkTestVectors() ? 0 : 1;
  }
  if (cmd === "scan") {
    console.error("scan은 아직 구현되지 않았습니다 (단계 1).");
    return 2;
  }
  console.error(USAGE);
  return 2;
}

// snarkjs가 띄운 워커 스레드가 남아 있어 프로세스가 끝나지 않으므로 직접 종료한다.
process.exit(await main(process.argv.slice(2)));

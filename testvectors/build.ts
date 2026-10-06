// 테스트 벡터 생성.
//
// 합성 벡터: 회로마다 snarkjs로 셋업을 돌려 Phase 2 기여 전(0000)과 후(0001) zkey를 만들고,
// 각각을 신형(0.7.x)·구형(0.6.11) 템플릿으로 내보낸다. 기여 전 zkey가 Veil·Foom과 같은 결함이다.
// 기여는 contribute 대신 beacon으로 한다. contribute는 엔트로피를 고정해도 OS 난수를 섞어서
// 빌드할 때마다 파일이 달라진다. beacon 값이 공개돼 있으므로 이 키들은 절대 실제로 쓰지 말 것.
//
// 체인 벡터: manifest.json의 onchain 항목 소스를 Blockscout에서 받아 testvectors/onchain/에 저장한다.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as snarkjs from "snarkjs";
import * as snarkjsOld from "snarkjs-old";
import { fetchVerifiedSource } from "../scanner/fetch.ts";
import { loadManifest, onchainPath, ROOT, TV_DIR } from "./manifest.ts";

const BUILD_DIR = join(TV_DIR, "build");
const SYNTHETIC_DIR = join(TV_DIR, "synthetic");
const CIRCUITS = ["multiplier", "product3"];
const PTAU_POWER = 6;
const PHASE1_BEACON = "0000000000000000000000000000000000000000000000000000000070686173653131"; // "phase11"
const PHASE2_BEACON = "0000000000000000000000000000000000000000000000000000000070686173653232"; // "phase22"
const BEACON_ITERATIONS_EXP = 10;

const TEMPLATES = {
  new: { exporter: snarkjs.zKey, template: join(ROOT, "node_modules/snarkjs/templates/verifier_groth16.sol.ejs") },
  old: { exporter: snarkjsOld.zKey, template: join(ROOT, "node_modules/snarkjs-old/templates/verifier_groth16.sol.ejs") },
};

export async function buildTestVectors(opts: { refresh: boolean }): Promise<void> {
  await buildSynthetic();
  buildSyntheticBytecode();
  await fetchOnchain(opts.refresh);
}

// 바이트코드 판정용: 합성 검증기를 옵티마이저 끔(noopt)·켬 runs 200(opt)·켬 runs 20(size)으로 컴파일해
// 런타임 바이트코드를 저장한다. 구형 템플릿은 옵티마이저가 γ·δ의 같은 상수를 합치고(L15),
// runs가 낮으면 여러 번 쓰는 상수를 데이터 영역에 두고 CODECOPY로 읽는다(L33).
const SOLC = { new: "0.8.28", old: "0.6.12" };
export const BYTECODE_DIR = join(SYNTHETIC_DIR, "bytecode");

function buildSyntheticBytecode(): void {
  mkdirSync(BYTECODE_DIR, { recursive: true });
  for (const [style, solc] of Object.entries(SOLC)) {
    for (const [variant, runs] of [["noopt", null], ["opt", "200"], ["size", "20"]] as const) {
      const project = join(BUILD_DIR, `forge-${style}-${variant}`);
      mkdirSync(join(project, "src"), { recursive: true });
      const files = CIRCUITS.flatMap((c) => ["skip-phase2", "phase2"].map((phase) => `${c}.${phase}.${style}`));
      for (const f of files) {
        writeFileSync(join(project, "src", `${f.replaceAll(/[.-]/g, "_")}.sol`), readFileSync(join(SYNTHETIC_DIR, `${f}.sol`)));
      }
      // forge는 --optimizer-runs만 줘도 옵티마이저를 켜므로, 끌 때는 --optimize false를 명시하고 runs는 넘기지 않는다.
      const args = ["build", "--root", project, "--use", solc, "--force"];
      execFileSync("forge", runs ? [...args, "--optimize", "true", "--optimizer-runs", runs] : [...args, "--optimize", "false"], {
        stdio: "ignore",
      });
      for (const f of files) {
        const id = f.replaceAll(/[.-]/g, "_");
        const contract = style === "new" ? "Groth16Verifier" : "Verifier";
        const artifact = JSON.parse(readFileSync(join(project, "out", `${id}.sol`, `${contract}.json`), "utf8"));
        const out = join(BYTECODE_DIR, `${f}.${variant}.hex`);
        writeFileSync(out, `${artifact.deployedBytecode.object}\n`);
        console.log(`  bytecode   ${out.slice(ROOT.length)}`);
      }
    }
  }
}

async function buildSynthetic(): Promise<void> {
  mkdirSync(BUILD_DIR, { recursive: true });
  mkdirSync(SYNTHETIC_DIR, { recursive: true });

  const ptau = await buildPtau();

  for (const circuit of CIRCUITS) {
    execFileSync("circom", [join(TV_DIR, "circuits", `${circuit}.circom`), "--r1cs", "-o", BUILD_DIR], {
      stdio: "ignore",
    });
    const r1cs = join(BUILD_DIR, `${circuit}.r1cs`);
    const zkeys = {
      "skip-phase2": join(BUILD_DIR, `${circuit}_0000.zkey`),
      phase2: join(BUILD_DIR, `${circuit}_0001.zkey`),
    };
    await snarkjs.zKey.newZKey(r1cs, ptau, zkeys["skip-phase2"]);
    await snarkjs.zKey.beacon(zkeys["skip-phase2"], zkeys.phase2, "proofgap", PHASE2_BEACON, BEACON_ITERATIONS_EXP);

    for (const [phase, zkey] of Object.entries(zkeys)) {
      for (const [style, { exporter, template }] of Object.entries(TEMPLATES)) {
        const sol = await exporter.exportSolidityVerifier(zkey, { groth16: readFileSync(template, "utf8") });
        const out = join(SYNTHETIC_DIR, `${circuit}.${phase}.${style}.sol`);
        writeFileSync(out, sol);
        console.log(`  synthetic  ${out.slice(ROOT.length)}`);
      }
    }
  }
}

async function buildPtau(): Promise<string> {
  const final = join(BUILD_DIR, `pot${PTAU_POWER}_final.ptau`);
  if (existsSync(final)) return final;
  const p0 = join(BUILD_DIR, `pot${PTAU_POWER}_0000.ptau`);
  const p1 = join(BUILD_DIR, `pot${PTAU_POWER}_0001.ptau`);
  const curve = await snarkjs.curves.getCurveFromName("bn128");
  await snarkjs.powersOfTau.newAccumulator(curve, PTAU_POWER, p0);
  await snarkjs.powersOfTau.beacon(p0, p1, "proofgap", PHASE1_BEACON, BEACON_ITERATIONS_EXP);
  await snarkjs.powersOfTau.preparePhase2(p1, final);
  return final;
}

async function fetchOnchain(refresh: boolean): Promise<void> {
  for (const v of loadManifest()) {
    if (v.source.kind !== "onchain") continue;
    const { chain, address } = v.source;
    const out = onchainPath(chain, address);
    if (existsSync(out) && !refresh) continue;
    const src = await fetchVerifiedSource(chain, address);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(src, null, 2) + "\n");
    const warn = src.verifiedAtAddress ? "" : `  (주의: twin ${src.verifiedTwin}의 소스)`;
    console.log(`  onchain    ${chain}:${address} ${src.name}${warn}`);
  }
}

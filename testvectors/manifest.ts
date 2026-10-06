import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RuleId } from "../rules/index.ts";
import type { BytecodeVerdict } from "../scanner/bytecode.ts";
import type { Chain, VerifiedSource } from "../scanner/fetch.ts";
import type { TemplateId } from "../scanner/extract.ts";
import type { SourceFile } from "../scanner/source.ts";

export const ROOT = new URL("..", import.meta.url).pathname;
export const TV_DIR = join(ROOT, "testvectors");

export type VectorSet = "known-positive" | "synthetic-positive" | "synthetic-negative" | "real-negative";

export type Vector = {
  id: string;
  set: VectorSet;
  source: { kind: "file"; path: string } | { kind: "onchain"; chain: Chain; address: string };
  // 소스에 검증기가 여러 개일 때 판정할 컨트랙트 이름
  contract?: string;
  expect: { template: TemplateId | null; rules: RuleId[] };
  ref?: string;
  note?: string;
};

// 바이트코드 판정용 벡터: 합성 검증기를 옵티마이저 켬·끔으로 컴파일한 런타임 바이트코드
export type BytecodeVector = { id: string; path: string; expect: BytecodeVerdict; note?: string };

type Manifest = { vectors: Vector[]; bytecodeVectors: BytecodeVector[] };
const readManifest = () => JSON.parse(readFileSync(join(TV_DIR, "manifest.json"), "utf8")) as Manifest;

export const loadManifest = (): Vector[] => readManifest().vectors;
export const loadBytecodeVectors = (): BytecodeVector[] => readManifest().bytecodeVectors ?? [];

export function onchainPath(chain: Chain, address: string): string {
  return join(TV_DIR, "onchain", chain, `${address.toLowerCase()}.json`);
}

export function loadVectorSource(v: Vector): SourceFile[] {
  if (v.source.kind === "file") {
    return [{ path: v.source.path, content: readFileSync(join(ROOT, v.source.path), "utf8") }];
  }
  const stored = JSON.parse(readFileSync(onchainPath(v.source.chain, v.source.address), "utf8")) as VerifiedSource;
  return stored.files;
}

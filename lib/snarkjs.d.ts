// snarkjs는 타입 정의를 내보내지 않는다. 테스트 벡터 생성에 쓰는 함수만 선언한다.
// snarkjs-old는 package.json에서 snarkjs@0.6.11(구형 검증기 템플릿)을 가리키는 별칭이다.

declare module "snarkjs" {
  export const curves: { getCurveFromName(name: string): Promise<unknown> };
  export const powersOfTau: {
    newAccumulator(curve: unknown, power: number, fileName: string, logger?: unknown): Promise<unknown>;
    beacon(oldPtau: string, newPtau: string, name: string, beaconHash: string, numIterationsExp: number, logger?: unknown): Promise<unknown>;
    preparePhase2(oldPtau: string, newPtau: string, logger?: unknown): Promise<void>;
  };
  export const zKey: {
    newZKey(r1cs: string, ptau: string, zkey: string, logger?: unknown): Promise<unknown>;
    beacon(oldZkey: string, newZkey: string, name: string, beaconHash: string, numIterationsExp: number, logger?: unknown): Promise<unknown>;
    exportSolidityVerifier(zkey: string, templates: { groth16: string }, logger?: unknown): Promise<string>;
  };
}

declare module "snarkjs-old" {
  export const zKey: {
    exportSolidityVerifier(zkey: string, templates: { groth16: string }, logger?: unknown): Promise<string>;
  };
}

-- 이더리움 전체 컨트랙트 바이트코드에서 BN254 G2 생성원 좌표(x의 허수부)를 찾는다.
-- snarkjs Groth16 검증기는 γ를 생성원으로 고정하므로 이름·소스 검증 여부와 상관없이 전부 걸린다.
--
-- g2_gen_count는 좌표가 바이트코드에 나오는 횟수다. 정상 검증기는 보통 1(γ),
-- Phase 2를 건너뛴 검증기는 δ도 생성원이라 2 이상이 된다 (Veil 검증기 2, Tornado 1로 확인).
-- 컴파일러가 같은 상수를 합치면 틀릴 수 있으므로 판정이 아니라 우선순위 신호로만 쓴다.
--
-- 실행: proofgap candidates bigquery --chain ethereum [--dry-run]
SELECT
  address,
  block_number,
  block_timestamp,
  DIV(
    LENGTH(bytecode) - LENGTH(REPLACE(bytecode, '198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2', '')),
    64
  ) AS g2_gen_count
FROM `bigquery-public-data.crypto_ethereum.contracts`
WHERE STRPOS(bytecode, '198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2') > 0
ORDER BY g2_gen_count DESC, block_number

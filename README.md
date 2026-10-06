# proofgap

> 증명은 맞았는데 시스템이 틀린 곳을 찾는다.

**proofgap**은 체인에 배포된 ZK 검증 컨트랙트에서 **경계 결함**을 찾아내는 스캐너입니다. 경계 결함이란 증명 시스템은 설계대로 작동했는데, 그 바깥(셋업, 정산 로직, 검증 범위)이 잘못돼 생기는 결함을 말합니다. 결함이 있는 검증기를 찾으면, 그 검증기를 믿는 컨트랙트에 자산이 얼마나 묶여 있는지까지 함께 확인합니다.

**스캔 통계: https://0xshkwon.github.io/proofgap/stats/**

---

## 왜 만드는가

2026년 2월, Base의 프라이버시 풀 Veil과 Foom이 연달아 털렸습니다. 원인은 암호학이 아니었습니다. snarkjs 셋업의 Phase 2(회로별 무작위화)를 건너뛰어 검증키의 γ와 δ가 같은 값으로 남았고, 그 결과 검증기가 아무 증명이나 통과시키는 "도장"이 됐습니다. Foom은 Veil이 공개된 지 며칠 만에 같은 결함으로 털렸습니다.

이 결함은 검증키 상수만 보면 판정할 수 있습니다. 그런데도 복제 공격을 막지 못했습니다. 자동으로 찾아주는 도구가 없었기 때문입니다.

## 결과

이더리움, Base, Arbitrum, Optimism, Polygon 다섯 체인을 스캔했습니다.

| | |
| --- | --- |
| 수집한 후보 | 7,388 |
| 식별한 Groth16 검증기 | 2,585 |
| R1·R2 탐지 (γ == δ) | 139 (공개된 사고 Veil·Foom 40건 포함) |
| R3 묶음 (서로 다른 회로가 같은 δ 재사용) | 2 |
| 자산 $100 이상이 묶인 탐지 | 0 |
| 바이트코드 판정 정확도 | 소스 판정 867개 대비 오탐 0, 놓침 0 |

체인별 수치, 공개된 사고 목록, 수집 경로별 한계는 [스캔 통계 페이지](https://0xshkwon.github.io/proofgap/stats/)에 있습니다. 공개된 사고 외의 탐지 건은 주소를 공개하지 않습니다.

## 어떻게 동작하나

```
후보 수집 ──▶ 소스 있음 ──▶ 템플릿 분류 → 검증키 추출 → 규칙 판정 ─┐
(BigQuery,      │                                                   ├─▶ 노출 연결 ──▶ 트리아지 ──▶ 대시보드
 이름 검색,     └─ 소스 없음 ─▶ 바이트코드 판정 ─────────────────────┘   (호출자·잔고·권한)        (내부 / 공개)
 호출자 크롤링)
```

1. **후보 수집:** 체인마다 쓸 수 있는 경로로 검증기 후보를 모읍니다. 이더리움·Polygon은 BigQuery로 전체 바이트코드에서 G2 생성원을 찾고, 나머지는 Blockscout 이름 검색과 페어링 프리컴파일 호출자 크롤링을 씁니다.
2. **소스 판정:** 소스가 검증돼 있으면(Blockscout, 없으면 Sourcify) snarkjs Groth16 템플릿(신형·구형)을 식별하고, 검증키를 뽑아 곡선 위의 점인지 확인한 뒤 규칙을 적용합니다. 템플릿 밖의 검증기는 수동 검토 대기열로 보냅니다.
3. **바이트코드 판정:** 소스가 없으면 PUSH 상수에서 G2 점을 찾고, 템플릿이 β·γ·δ를 연달아 넣는 성질을 이용해 γ == δ를 판정합니다. 결론이 나지 않으면 "의심"으로 남깁니다.
4. **노출 연결:** 탐지된 검증기마다 호출자를 찾고(내부 호출, 같은 배포자의 컨트랙트, 바이트코드 참조), 잔고와 권한(프록시, owner, 정지 기능)을 확인합니다.
5. **트리아지:** 자산 규모로 우선순위를 매기고, 연락처 후보를 찾고, 비공개 제보 초안을 만듭니다.
6. **대시보드:** 내부용(개별 주소 포함)과 공개용(집계 숫자, 정확도, 공개된 사고)을 만듭니다.

## 탐지 규칙

| ID | 조건 | 심각도 | 상태 |
| --- | --- | --- | --- |
| R1 | γ == δ | 치명 | 구현 |
| R2 | δ == BN254 G2 기본 생성원 | 치명 | 구현 |
| R3 | 같은 δ가 서로 다른 회로의 검증기에서 재사용됨 | 정보 | 구현 |
| R4 | 공개 입력에 스칼라 필드 범위 검사가 없음 | 높음 (조건부) | 보류 |

**주의: γ가 생성원인 것은 정상입니다.** snarkjs는 γ를 G2 생성원으로 고정하고 Phase 2에서 δ만 무작위화합니다. "γ == 생성원"을 규칙으로 쓰면 정상적인 검증기가 전부 걸립니다. 규칙별 조건, 근거, 바이트코드 판정 기준은 [`docs/rules.md`](docs/rules.md)에 있습니다.

## 범위

| | 하는 것 | 보류 | 하지 않는 것 |
| --- | --- | --- | --- |
| 증명 시스템 | Groth16 (snarkjs 검증기) | PLONK, Halo2 | STARK 파라미터 평가 |
| 체인 | 이더리움, Base, Arbitrum, Optimism, Polygon | BNB (무료 후보 수집 경로 없음) | 비EVM 체인 |
| 입력 | 소스가 검증된 컨트랙트, 소스 미검증 바이트코드 | | 오프체인 검증기 |
| 결함 | 셋업 경계 (R1~R3) | 공개 입력 범위 (R4) | 회로 제약 결함 자동 탐지 |

후보 수집 경로마다 커버리지가 다릅니다.

| 경로 | 체인 | 잡는 것 | 놓치는 것 |
| --- | --- | --- | --- |
| `bigquery` | 이더리움, Polygon | 바이트코드에 G2 생성원이 있는 모든 컨트랙트 (소스 미검증 포함) | 데이터셋 갱신 이후 배포분 (Polygon은 2024-09 이후 전부) |
| `crawl` | Base, Arbitrum, Optimism, Polygon | 최근 기간에 실제로 호출된 검증기 | 그 기간에 호출되지 않은 검증기 (Blockscout가 오래된 구간에서 타임아웃) |
| `search` | 전체 | 이름에 검색어가 들어간 검증된 컨트랙트 | 이름을 바꾼 검증기, 소스 미검증 컨트랙트 |

그래서 Base·Arbitrum·Optimism에서는 이름을 바꾸고 소스도 검증하지 않은 검증기를 놓칠 수 있습니다.

## 디렉터리 구조

```
proofgap/
├── bin/            # CLI (proofgap)
├── lib/            # BN254 연산, 검증키 지문
├── scanner/        # 후보 수집, 소스 수집, 템플릿 분류, 검증키 추출, 바이트코드 판정
├── rules/          # 탐지 규칙 R1~R3
├── exposure/       # 호출자 탐색, 잔고 스냅샷, 권한 확인
├── triage/         # 우선순위, 연락처 후보, 비공개 제보 초안
├── dashboard/      # 내부 대시보드, 공개 통계 페이지 생성
├── testvectors/    # 정답을 아는 입력 (합성·실제 양성·음성, 바이트코드, R3)
├── docs/
│   ├── rules.md            # 규칙별 조건, 근거, 오탐 주의점
│   ├── disclosure.md       # 디스클로저 절차
│   ├── troubleshooting.md  # 트러블슈팅 로그
│   └── stats/              # 공개 통계 페이지 (GitHub Pages)
└── data/           # 스캔 결과 (커밋하지 않음)
```

## 시작하기

필요한 도구:

- Node.js 24 이상: TypeScript를 빌드 없이 바로 실행합니다
- [circom](https://docs.circom.io/) 2.1 이상, [Foundry](https://book.getfoundry.sh/): 테스트 벡터 생성 (snarkjs는 `npm install`로 신형 0.7.6·구형 0.6.11이 함께 설치됨)
- [BigQuery](https://cloud.google.com/bigquery) `bq` CLI: 이더리움·Polygon 후보 수집. 무료 샌드박스로 충분합니다
- [Blockscout](https://www.blockscout.com/), [Sourcify](https://sourcify.dev/), 공개 RPC: 키 없이 씁니다. RPC는 `ETHEREUM_RPC_URL` 같은 환경변수로 바꿀 수 있습니다

```bash
npm install
npm link        # proofgap 명령어 등록 (또는 node bin/proofgap.ts ...)
npm test        # 테스트 벡터 48개 (네트워크 불필요)

# 1. 후보 수집 (체인: ethereum, base, arbitrum, optimism, polygon)
proofgap candidates bigquery --chain ethereum --dry-run   # 처리량만 확인
proofgap candidates bigquery --chain ethereum
proofgap candidates crawl  --chain base --days 30
proofgap candidates search --chain base --term Verifier

# 2. 판정
proofgap scan --chain base --address 0x...       # 컨트랙트 하나
proofgap scan --chain base --all                 # 수집한 후보 전체 (소스)
proofgap bytecode scan  --chain base             # 소스 미검증 후보 (바이트코드)
proofgap bytecode check --chain base             # 바이트코드 판정 정확도 확인
proofgap rules r3                                # 모든 체인의 R3 묶음
proofgap report --chain base

# 3. 노출 연결과 트리아지
proofgap exposure --chain base
proofgap exposure refs --chain ethereum          # 바이트코드 참조로 호출자 추가 (BigQuery)
proofgap triage --chain base
proofgap triage draft --chain base --address 0x...

# 4. 대시보드 (내부: data/dashboard/, 공개: docs/stats/)
proofgap dashboard
```

스캔·노출·트리아지 결과는 모두 `data/`에 저장되고 커밋되지 않습니다. 공개 통계 페이지는 정적이라, 다시 스캔한 뒤 `proofgap dashboard`를 돌리고 `docs/stats/`를 커밋해야 갱신됩니다.

## 테스트 벡터

규칙은 정답을 아는 입력으로 먼저 검증합니다. 양성과 음성을 모두 갖춰야 오탐률을 잴 수 있습니다.

| 세트 | 내용 | 기대 결과 |
| --- | --- | --- |
| 알려진 양성 (4) | Veil, Foom 검증기 | R1·R2 탐지 |
| 합성 양성 (5) | Phase 2를 건너뛴 snarkjs 검증기 (신형·구형), 템플릿 밖 검증기 | R1·R2 탐지, 템플릿 밖은 미분류 |
| 합성 음성 (4) | Phase 2 기여를 마친 같은 회로의 검증기 | 미탐지 |
| 실제 음성 (10) | 공개 세레모니를 거친 프로토콜의 검증기와 변형 (Privacy Pools, Tornado Cash, Hermez, gnark·ZoKrates 등) | 미탐지 |
| 바이트코드 (24) | 합성 검증기를 옵티마이저 끔·켬·runs 20으로 컴파일 | 탐지·의심·정상 |
| R3 (1) | 같은 비컨으로 만든 합성 phase2 두 회로 | R3 묶음 하나 |

## 책임 있는 공개

이 도구는 살아 있는 취약 컨트랙트를 찾을 수 있습니다. Foom은 Veil이 공개된 지 며칠 만에 같은 결함으로 털렸습니다. 그래서 아래 원칙을 지킵니다.

- **메인넷에 트랜잭션을 보내지 않습니다.** RPC는 읽기 메서드만 씁니다. 화이트햇 구조가 필요하면 SEAL 911 같은 전문 조직에 넘깁니다.
- **위조 증명을 만들지 않습니다.** 판정은 검증키 상수만으로 합니다.
- **자산이 묶인 취약 검증기는 비공개 제보가 먼저입니다.** 지금까지 자산 $100 이상이 묶인 건은 없습니다.
- **공개 통계에는 집계 수치, 판정 정확도, 이미 공개된 사고의 주소만 담습니다.** 그 밖의 탐지 건은 주소를 싣지 않고, `proofgap dashboard`는 미공개 주소가 섞이면 생성을 멈춥니다.

절차는 [`docs/disclosure.md`](docs/disclosure.md)에 있습니다.

## 트러블슈팅 로그

개발하다 막힌 문제와 해결 과정은 [`docs/troubleshooting.md`](docs/troubleshooting.md)에 남깁니다 (L01~L35). 예를 들면:

- "γ == 생성원"을 규칙으로 쓰면 정상 검증기가 전부 걸림 (L01)
- 옵티마이저가 같은 상수를 합치거나(L15) 데이터 영역으로 옮기면(L33) 바이트코드에서 δ가 사라짐
- 소스 판정 867개와 대조해 바이트코드 판정 기준을 정함 (L28~L30)

## 참고 자료

- [The First ZK Exploits Happened, and They Weren't What We Expected](https://blog.zksecurity.xyz/posts/groth16-setup-exploit/) (ZKSecurity)
- [The Unfinished Proof](https://rekt.news/the-unfinished-proof) (Rekt)
- [Veil Cash Groth16 Forgery](https://www.darknavy.org/web3/exploits/veil-cash-groth16-forgery/) (DarkNavy)
- [EIP-197: Precompiled contracts for optimal ate pairing check on the elliptic curve alt_bn128](https://eips.ethereum.org/EIPS/eip-197)

## 라이선스

[MIT](LICENSE). 누구나 자유롭게 쓰고 고치고 배포할 수 있습니다.

다만 테스트 벡터 중 다른 프로젝트에서 온 파일은 각 파일에 적힌 원래 라이선스를 따릅니다. `testvectors/onchain/`은 체인에 배포된 컨트랙트의 검증된 소스(대부분 GPL-3.0, Hermez는 AGPL-3.0)이고, `testvectors/synthetic/`의 `.sol`은 snarkjs 템플릿으로 생성한 검증기(GPL-3.0)와 그 컴파일 결과입니다.

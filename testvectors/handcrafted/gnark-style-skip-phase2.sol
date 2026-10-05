// SPDX-License-Identifier: MIT
// 손으로 만든 벡터: snarkjs 템플릿이 아닌 검증기 (gnark 스타일 상수 이름).
// δ를 G2 생성원으로 두어 γ == δ 결함을 일부러 넣었다. 컴파일·배포용이 아니다.
// 기대 결과: 템플릿 분류에 걸리지 않고 수동 검토 대기열로 간다.
pragma solidity ^0.8.0;

contract CustomVerifier {
    uint256 constant GAMMA_NEG_X_0 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant GAMMA_NEG_X_1 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant DELTA_NEG_X_0 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant DELTA_NEG_X_1 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;

    function verifyProof(uint256[8] calldata proof, uint256[1] calldata input) external view {
        bool success;
        assembly {
            let f := mload(0x40)
            success := staticcall(gas(), 8, f, 768, f, 0x20)
        }
        require(success);
    }
}

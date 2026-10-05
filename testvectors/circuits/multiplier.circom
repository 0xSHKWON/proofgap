pragma circom 2.1.0;

// 공개 신호 1개 (c)
template Multiplier() {
    signal input a;
    signal input b;
    signal output c;
    c <== a * b;
}

component main = Multiplier();

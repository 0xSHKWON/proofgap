pragma circom 2.1.0;

// 공개 신호 3개 (o, x, y). IC 배열이 여러 개일 때 추출을 확인하는 용도.
template Product3() {
    signal input x;
    signal input y;
    signal input z;
    signal output o;
    signal t;
    t <== x * y;
    o <== t * z;
}

component main {public [x, y]} = Product3();

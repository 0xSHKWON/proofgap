// 소스 주석에서 보안 연락처 후보를 찾는다. 읽기만 하고 연락은 하지 않는다.

import type { SourceFile } from "../scanner/source.ts";

export type Contact = { kind: "security-contact" | "email" | "url"; value: string; file: string };

// 템플릿·라이선스에 늘 들어가는 주소는 연락처가 아니다.
const NOISE = /gnu\.org|iden3|snarkjs|circom|openzeppelin|github\.com\/ethereum|eips\.ethereum\.org|solidity|spdx|example\.com|0kims/i;
// 의존성 라이브러리 파일의 주석은 프로젝트 연락처가 아니다.
const DEPENDENCY_PATH = /(^|\/)(lib|node_modules|dependencies)\/|@openzeppelin|forge-std|solmate|solady/i;
// URL은 보안 연락 경로로 보이는 것만 남긴다 (문서·논문 링크가 대부분이라서).
const SECURITY_URL = /security|bounty|immunefi|hackenproof|cantina|disclos|vuln|\.well-known/i;

export function findContacts(files: SourceFile[]): Contact[] {
  const out = new Map<string, Contact>();
  for (const f of files) {
    if (DEPENDENCY_PATH.test(f.path)) continue;
    const comments = commentsOf(f.content);
    for (const m of comments.matchAll(/@custom:security-contact\s+(\S+)/g)) {
      out.set(m[1], { kind: "security-contact", value: m[1], file: f.path });
    }
    for (const m of comments.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) {
      if (!NOISE.test(m[0]) && !out.has(m[0])) out.set(m[0], { kind: "email", value: m[0], file: f.path });
    }
    for (const m of comments.matchAll(/https?:\/\/[^\s)>"']+/g)) {
      if (SECURITY_URL.test(m[0]) && !NOISE.test(m[0]) && !out.has(m[0])) out.set(m[0], { kind: "url", value: m[0], file: f.path });
    }
  }
  return [...out.values()];
}

// 문자열 안의 //도 걸리지만, 연락처 후보를 찾는 용도라 넓게 잡아도 된다.
const commentsOf = (src: string): string => (src.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g) ?? []).join("\n");

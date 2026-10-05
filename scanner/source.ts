// 솔리디티 소스를 컨트랙트 단위로 자른다. 파서가 아니라 분류·추출에 필요한 만큼만 한다.

export type SourceFile = { path: string; content: string };

export type ContractBlock = {
  file: string;
  kind: "contract" | "library";
  name: string;
  body: string; // 주석을 지운 본문
};

// 문자열 리터럴은 그대로 두고 주석만 공백으로 바꾼다.
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '"' || c === "'") {
      const end = skipString(src, i);
      out += src.slice(i, end);
      i = end;
    } else if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function skipString(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length && src[i] !== quote) {
    if (src[i] === "\\") i++;
    i++;
  }
  return i + 1;
}

const HEADER = /\b(?:abstract\s+)?(contract|library)\s+([A-Za-z_]\w*)[^{;]*\{/g;

export function splitContracts(files: SourceFile[]): ContractBlock[] {
  const blocks: ContractBlock[] = [];
  for (const file of files) {
    const src = stripComments(file.content);
    for (const m of src.matchAll(HEADER)) {
      const open = m.index + m[0].length - 1;
      const close = matchBrace(src, open);
      if (close === -1) continue;
      blocks.push({
        file: file.path,
        kind: m[1] as ContractBlock["kind"],
        name: m[2],
        body: src.slice(open + 1, close),
      });
    }
  }
  return blocks;
}

function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      i = skipString(src, i) - 1;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

import { getEncoding, type Tiktoken } from "js-tiktoken";

// text-embedding-3-small and gpt-4o both share the cl100k_base encoding for
// token counting purposes that matter to chunking. gpt-4o's o200k_base is
// only marginally different and not worth the second encoding download.
let _enc: Tiktoken | null = null;

function getCl100k(): Tiktoken {
  if (!_enc) _enc = getEncoding("cl100k_base");
  return _enc;
}

export function countTokens(text: string): number {
  return getCl100k().encode(text).length;
}

export function createTiktokenTokenizer(): (text: string) => number {
  const enc = getCl100k();
  return (text: string) => enc.encode(text).length;
}

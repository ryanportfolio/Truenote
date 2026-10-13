/**
 * In-memory BM25 over the compliance passages: the keyword leg of the
 * compliance assistant's hybrid retrieval. Customer knowledge uses Postgres
 * full-text search instead; compliance text never enters the database.
 *
 * Tokens are lowercased runs of letters and digits, with hyphenated
 * identifiers kept whole as well as split ("ac-2" yields "ac-2", "ac", "2"),
 * so control ids and POA&M item numbers match exactly.
 */

const K1 = 1.2;
const B = 0.75;

const STOPWORDS = new Set(
  (
    "a an and are as at be by can do does for from has have how i if in is it its " +
    "of on or our should that the their there this to was we what when where which " +
    "who why will with you your"
  ).split(" ")
);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}]+(?:[-.][\p{L}\p{N}]+)*/gu)) {
    const token = match[0];
    if (/[-.]/.test(token)) {
      out.push(token);
      for (const part of token.split(/[-.]/)) {
        if (part && !STOPWORDS.has(part)) out.push(part);
      }
    } else if (!STOPWORDS.has(token)) {
      out.push(token);
    }
  }
  return out;
}

export interface Bm25Index {
  search(query: string, k: number): Array<{ index: number; score: number }>;
}

export function buildBm25Index(texts: string[]): Bm25Index {
  const termFrequencies = texts.map((text) => {
    const counts = new Map<string, number>();
    for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
    return counts;
  });
  const lengths = termFrequencies.map((counts) => {
    let total = 0;
    for (const count of counts.values()) total += count;
    return total;
  });
  const averageLength =
    lengths.length === 0 ? 0 : lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
  const documentFrequency = new Map<string, number>();
  for (const counts of termFrequencies) {
    for (const term of counts.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const total = texts.length;

  return {
    search(query, k) {
      const terms = Array.from(new Set(tokenize(query)));
      const scored: Array<{ index: number; score: number }> = [];
      termFrequencies.forEach((counts, index) => {
        let score = 0;
        for (const term of terms) {
          const tf = counts.get(term);
          if (!tf) continue;
          const df = documentFrequency.get(term) ?? 0;
          const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
          const norm = 1 - B + B * ((lengths[index] ?? 0) / (averageLength || 1));
          score += idf * ((tf * (K1 + 1)) / (tf + K1 * norm));
        }
        if (score > 0) scored.push({ index, score });
      });
      scored.sort((left, right) => right.score - left.score || left.index - right.index);
      return scored.slice(0, k);
    }
  };
}

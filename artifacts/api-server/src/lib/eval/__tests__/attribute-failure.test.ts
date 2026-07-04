import { describe, expect, it } from "vitest";
import { attributeFailure } from "../runner.js";

describe("attributeFailure", () => {
  it("blames retrieval when the expected doc never became a candidate", () => {
    expect(
      attributeFailure({ retrievalHit: false, rerankHit: false, gateRefused: true })
    ).toBe("retrieval");
  });

  it("blames the reranker when the doc was a candidate but cut from top-K", () => {
    expect(
      attributeFailure({ retrievalHit: true, rerankHit: false, gateRefused: false })
    ).toBe("rerank");
  });

  it("blames the threshold when the doc reached top-K but the gate refused", () => {
    expect(
      attributeFailure({ retrievalHit: true, rerankHit: true, gateRefused: true })
    ).toBe("threshold");
  });

  it("blames generation when the doc reached the LLM and the answer still failed", () => {
    expect(
      attributeFailure({ retrievalHit: true, rerankHit: true, gateRefused: false })
    ).toBe("generation");
  });

  it("returns null when hits are unknowable (no expected_doc_id)", () => {
    expect(
      attributeFailure({ retrievalHit: null, rerankHit: null, gateRefused: false })
    ).toBeNull();
  });
});

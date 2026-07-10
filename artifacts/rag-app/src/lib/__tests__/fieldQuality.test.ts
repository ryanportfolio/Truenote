import { describe, expect, it } from "vitest";
import { createGovernor, QUALITY_TIERS } from "../fieldQuality";

/** Feed n identical deltas, return the last non-"same" verdict (or "same"). */
function feed(gov: ReturnType<typeof createGovernor>, deltaMs: number, n: number): string {
  let last = "same";
  for (let i = 0; i < n; i++) {
    const v = gov.sample(deltaMs);
    if (v !== "same") last = v;
  }
  return last;
}

describe("createGovernor", () => {
  it("holds tier 0 on fast hardware", () => {
    const gov = createGovernor();
    expect(feed(gov, 33, 500)).toBe("same");
    expect(gov.tier).toEqual(QUALITY_TIERS[0]);
  });

  it("steps down one tier per full slow window, then freezes at the floor", () => {
    const gov = createGovernor();

    expect(feed(gov, 50, 45)).toBe("stepped");
    expect(gov.tier).toEqual(QUALITY_TIERS[1]);

    expect(feed(gov, 50, 45)).toBe("stepped");
    expect(gov.tier).toEqual(QUALITY_TIERS[2]);

    expect(feed(gov, 50, 45)).toBe("freeze");
    // Freeze never advances past the last tier.
    expect(gov.tier).toEqual(QUALITY_TIERS[2]);
  });

  it("needs a FULL window before judging — never steps early", () => {
    const gov = createGovernor();
    expect(feed(gov, 100, 44)).toBe("same");
    expect(gov.tier).toEqual(QUALITY_TIERS[0]);
    expect(gov.sample(100)).toBe("stepped");
  });

  it("treats spikes (tab switch, main-thread stall) as noise, not GPU load", () => {
    const gov = createGovernor();
    // 44 slow samples, then a resume-sized spike: window resets.
    feed(gov, 50, 44);
    expect(gov.sample(5000)).toBe("same");
    // The next 44 slow samples still aren't a full window.
    expect(feed(gov, 50, 44)).toBe("same");
    expect(gov.tier).toEqual(QUALITY_TIERS[0]);
    // Sample 45 completes it.
    expect(gov.sample(50)).toBe("stepped");
  });

  it("a healthy window keeps the current tier and starts fresh", () => {
    const gov = createGovernor();
    feed(gov, 50, 45); // now at tier 1
    expect(feed(gov, 33, 45)).toBe("same");
    expect(gov.tier).toEqual(QUALITY_TIERS[1]);
    // Never steps back up even after sustained fast frames.
    expect(feed(gov, 16, 200)).toBe("same");
    expect(gov.tier).toEqual(QUALITY_TIERS[1]);
  });
});

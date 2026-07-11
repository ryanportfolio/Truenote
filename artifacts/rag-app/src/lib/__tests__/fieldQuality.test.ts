import { describe, expect, it } from "vitest";
import { createGovernor, FIRST_WINDOW, QUALITY_TIERS } from "../fieldQuality";

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

  it("judges the first window fast, then one tier per steady window, then freezes", () => {
    const gov = createGovernor();

    // First window is short so a struggling machine steps down quickly.
    expect(feed(gov, 50, FIRST_WINDOW)).toBe("stepped");
    expect(gov.tier).toEqual(QUALITY_TIERS[1]);

    // Subsequent windows use the longer steady-state size.
    expect(feed(gov, 50, 45)).toBe("stepped");
    expect(gov.tier).toEqual(QUALITY_TIERS[2]);

    expect(feed(gov, 50, 45)).toBe("freeze");
    // Freeze never advances past the last tier.
    expect(gov.tier).toEqual(QUALITY_TIERS[2]);
  });

  it("needs a FULL window before judging — never steps early", () => {
    const gov = createGovernor();
    expect(feed(gov, 100, FIRST_WINDOW - 1)).toBe("same");
    expect(gov.tier).toEqual(QUALITY_TIERS[0]);
    expect(gov.sample(100)).toBe("stepped");

    // Steady-state window is 45: 44 slow samples don't judge yet.
    expect(feed(gov, 100, 44)).toBe("same");
    expect(gov.tier).toEqual(QUALITY_TIERS[1]);
    expect(gov.sample(100)).toBe("stepped");
  });

  it("a healthy first window still switches to the steady-state cadence", () => {
    const gov = createGovernor();
    // Fast first window: no step, but the window size grows to 45.
    expect(feed(gov, 33, FIRST_WINDOW)).toBe("same");
    // 44 slow samples aren't enough anymore...
    expect(feed(gov, 50, 44)).toBe("same");
    // ...the 45th completes the window.
    expect(gov.sample(50)).toBe("stepped");
    expect(gov.tier).toEqual(QUALITY_TIERS[1]);
  });

  it("treats spikes (tab switch, main-thread stall) as noise, not GPU load", () => {
    const gov = createGovernor();
    // Slow samples just shy of the first window, then a resume-sized
    // spike: the window resets without judging.
    feed(gov, 50, FIRST_WINDOW - 1);
    expect(gov.sample(5000)).toBe("same");
    // The next FIRST_WINDOW - 1 slow samples still aren't a full window.
    expect(feed(gov, 50, FIRST_WINDOW - 1)).toBe("same");
    expect(gov.tier).toEqual(QUALITY_TIERS[0]);
    // The final sample completes it.
    expect(gov.sample(50)).toBe("stepped");
  });

  it("a healthy window keeps the current tier and starts fresh", () => {
    const gov = createGovernor();
    feed(gov, 50, FIRST_WINDOW); // now at tier 1
    expect(feed(gov, 33, 45)).toBe("same");
    expect(gov.tier).toEqual(QUALITY_TIERS[1]);
    // Never steps back up even after sustained fast frames.
    expect(feed(gov, 16, 200)).toBe("same");
    expect(gov.tier).toEqual(QUALITY_TIERS[1]);
  });
});

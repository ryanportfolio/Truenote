import { describe, expect, it } from "vitest";
import { EVIDENCE_CHECKS } from "../catalog.js";
import { CHECK_RUNNERS, RETIRED_CHECK_IDS, runEvidenceChecks } from "../runner.js";

describe("retired evidence checks", () => {
  it("are no longer in the catalog or the runners", () => {
    for (const id of RETIRED_CHECK_IDS) {
      expect(EVIDENCE_CHECKS.some((check) => check.id === id)).toBe(false);
      expect(CHECK_RUNNERS[id]).toBeUndefined();
    }
  });

  it("are skipped when a queued manual run still names them", async () => {
    const run = await runEvidenceChecks(["external.dns-caa", "github.open-alerts"]);
    expect(run.entries).toEqual([]);
  });

  it("still reject an id that never existed", async () => {
    await expect(runEvidenceChecks(["external.no-such-check"])).rejects.toThrow("unknown check external.no-such-check");
  });
});

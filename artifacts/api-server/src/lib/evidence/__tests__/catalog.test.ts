import { describe, expect, it } from "vitest";
import nist from "../nist-800-53r5-moderate.json" with { type: "json" };
import { CATALOG_VERSION, EVIDENCE_CHECKS } from "../catalog.js";
import { CHECK_RUNNERS } from "../runner.js";

const controls = nist.controls as Record<string, { title: string; objectives: string[] }>;

describe("evidence check catalog", () => {
  it("has unique check ids", () => {
    const ids = EVIDENCE_CHECKS.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("cites only Moderate-baseline controls", () => {
    for (const check of EVIDENCE_CHECKS) {
      for (const control of check.controls) {
        expect(controls[control], `${check.id}: ${control}`).toBeDefined();
      }
    }
  });

  it("cites only SP 800-53A objectives that belong to one of the check's controls", () => {
    for (const check of EVIDENCE_CHECKS) {
      const allowed = new Set(check.controls.flatMap((control) => controls[control]?.objectives ?? []));
      for (const objective of check.objectives) {
        expect(allowed.has(objective), `${check.id}: ${objective}`).toBe(true);
      }
      // Every control is backed by at least one cited objective.
      for (const control of check.controls) {
        const own = new Set(controls[control]?.objectives ?? []);
        expect(check.objectives.some((objective) => own.has(objective)), `${check.id}: ${control}`).toBe(true);
      }
    }
  });

  it("registers a runner for every automated check and a check for every runner", () => {
    // Recorded outside the daily runners: attestation by upload, summary at the
    // run's end, operator by an owner-run script.
    const notRun = new Set(["attestation", "summary", "operator"]);
    for (const check of EVIDENCE_CHECKS) {
      expect(Object.hasOwn(CHECK_RUNNERS, check.id), `${check.id} (${check.kind})`).toBe(!notRun.has(check.kind));
    }
    const ids = new Set(EVIDENCE_CHECKS.map((check) => check.id));
    for (const id of Object.keys(CHECK_RUNNERS)) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it("states a pass condition and a proposed or approved cadence for every check", () => {
    for (const check of EVIDENCE_CHECKS) {
      expect(check.passCondition.length, check.id).toBeGreaterThan(20);
      expect(["proposed", "approved"]).toContain(check.cadenceStatus);
    }
  });

  it("pins the NIST source and versions the catalog", () => {
    expect(nist.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(controls)).toHaveLength(287);
    expect(CATALOG_VERSION).toMatch(/^[0-9a-f]{64}$/);
  });
});

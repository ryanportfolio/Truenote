import { describe, expect, it } from "vitest";
import {
  canReadClassification,
  classificationRank,
  parseClassification
} from "../classification.js";

describe("classification policy", () => {
  it("orders the default taxonomy from public through restricted", () => {
    expect(classificationRank("public")).toBeLessThan(classificationRank("internal"));
    expect(classificationRank("internal")).toBeLessThan(classificationRank("confidential"));
    expect(classificationRank("confidential")).toBeLessThan(classificationRank("restricted"));
  });

  it("fails closed for unknown labels and enforces clearance", () => {
    expect(parseClassification("secret")).toBeNull();
    expect(canReadClassification("internal", "public")).toBe(true);
    expect(canReadClassification("internal", "confidential")).toBe(false);
  });
});

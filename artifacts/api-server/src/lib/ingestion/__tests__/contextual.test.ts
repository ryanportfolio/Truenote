import { describe, expect, it } from "vitest";
import {
  buildContextHeader,
  prependContextHeader,
  stripContextHeader
} from "../contextual.js";

describe("buildContextHeader", () => {
  it("joins title and heading path", () => {
    expect(buildContextHeader("Refund Policy", ["Fees", "Cancellation"])).toBe(
      "[Refund Policy > Fees > Cancellation]"
    );
  });

  it("drops an H1 that restates the doc title (case-insensitive)", () => {
    expect(buildContextHeader("Refund Policy", ["refund policy", "Fees"])).toBe(
      "[Refund Policy > Fees]"
    );
  });

  it("skips the empty strings the chunker pads skipped heading levels with", () => {
    expect(buildContextHeader("Doc", ["", "Section"])).toBe("[Doc > Section]");
  });

  it("handles a title-only header and a fully empty input", () => {
    expect(buildContextHeader("Doc")).toBe("[Doc]");
    expect(buildContextHeader("", [])).toBe("");
    expect(buildContextHeader("   ", ["", "  "])).toBe("");
  });
});

describe("prependContextHeader", () => {
  it("prepends the header on its own line", () => {
    expect(prependContextHeader("[Doc > A]", "body")).toBe("[Doc > A]\nbody");
  });

  it("is idempotent", () => {
    const once = prependContextHeader("[Doc > A]", "body");
    expect(prependContextHeader("[Doc > A]", once)).toBe(once);
  });

  it("no-ops on an empty header", () => {
    expect(prependContextHeader("", "body")).toBe("body");
  });
});

describe("stripContextHeader", () => {
  it("removes a previously prepended header", () => {
    expect(stripContextHeader("[Old Doc]\nbody", "[Old Doc]")).toBe("body");
  });

  it("leaves content alone when the header does not match", () => {
    expect(stripContextHeader("[New Doc]\nbody", "[Old Doc]")).toBe("[New Doc]\nbody");
    expect(stripContextHeader("body", undefined)).toBe("body");
  });

  it("round-trips with prepend across a doc rename", () => {
    const v1 = prependContextHeader("[Old Title]", "body");
    const v2 = prependContextHeader("[New Title]", stripContextHeader(v1, "[Old Title]"));
    expect(v2).toBe("[New Title]\nbody");
  });
});

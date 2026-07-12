import { describe, expect, it } from "vitest";
import { robotsHeaderForSpaPath } from "../seo.js";

describe("robotsHeaderForSpaPath", () => {
  it("allows the public homepage to be indexed", () => {
    expect(robotsHeaderForSpaPath("/")).toBeNull();
  });

  it.each([
    "/login",
    "/forgot-password",
    "/reset-password",
    "/chat",
    "/kb/document-1",
    "/admin/users"
  ])("prevents indexing private SPA route %s", (path) => {
    expect(robotsHeaderForSpaPath(path)).toBe("noindex, nofollow");
  });
});

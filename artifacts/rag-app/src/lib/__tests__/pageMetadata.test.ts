import { describe, expect, it } from "vitest";
import { pageTitleForPath, PUBLIC_HOME_TITLE } from "../pageMetadata";

describe("pageTitleForPath", () => {
  it("keeps the public homepage descriptive", () => {
    expect(pageTitleForPath("/")).toBe(PUBLIC_HOME_TITLE);
  });

  it("labels protected task routes without exposing page data", () => {
    expect(pageTitleForPath("/chat")).toBe("Ask a Question | Truenote");
    expect(pageTitleForPath("/kb/document-1")).toBe("Knowledge Base | Truenote");
    expect(pageTitleForPath("/admin/users?role=manager")).toBe("Users | Truenote");
  });

  it("labels unknown routes as not found", () => {
    expect(pageTitleForPath("/missing")).toBe("Page Not Found | Truenote");
  });
});

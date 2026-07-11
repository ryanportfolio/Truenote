import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AppShellBoot, isProtectedPath, RouteBoot } from "../AppShellBoot";

describe("isProtectedPath", () => {
  it.each([
    "/chat",
    "/kb",
    "/kb/document-1",
    "/admin/documents",
    "/admin/users?role=manager"
  ])("treats %s as an authenticated surface", (path) => {
    expect(isProtectedPath(path)).toBe(true);
  });

  it.each([
    "/",
    "/login",
    "/forgot-password",
    "/reset-password?token=test",
    "/change-password"
  ])("keeps %s on the public boot treatment", (path) => {
    expect(isProtectedPath(path)).toBe(false);
  });

  it("renders protected chrome immediately without interactive controls", () => {
    const html = renderToStaticMarkup(<AppShellBoot path="/chat" />);
    expect(html).toContain("app-shell flex h-screen flex-col");
    expect(html).toContain("topbar-shell");
    expect(html).toContain("w-16 flex-col p-2 md:w-60");
    expect(html).toContain("Ask with certainty.");
    expect(html).not.toMatch(/<(?:a|button|input|select|textarea)\b/);
  });

  it("uses knowledge-base-shaped main geometry for /kb", () => {
    const html = renderToStaticMarkup(<RouteBoot path="/kb" />);
    expect(html).toContain("Knowledge base");
    expect(html).toContain("h-[38px]");
    expect(html).toContain("border-border bg-card shadow-card");
  });
});

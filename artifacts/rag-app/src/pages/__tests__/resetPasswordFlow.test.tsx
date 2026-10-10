import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/types/api";
import { finishReset, RESET_SIGN_IN_PATH } from "../ResetPassword";
import { LoginPage } from "../Login";

const user: CurrentUser = {
  id: "u1",
  email: "person@example.com",
  role: "csr",
  programId: "p1",
  name: "Person",
  mustResetPassword: false
};

afterEach(() => vi.unstubAllGlobals());

describe("finishReset()", () => {
  it("signs the user in and goes to the landing page", () => {
    const onAuthenticated = vi.fn();
    const navigate = vi.fn();
    finishReset({ status: "authenticated", user }, onAuthenticated, navigate);
    expect(onAuthenticated).toHaveBeenCalledWith(user);
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("sends a second-factor account to the login page without signing in", () => {
    const onAuthenticated = vi.fn();
    const navigate = vi.fn();
    finishReset({ status: "sign_in_required" }, onAuthenticated, navigate);
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(RESET_SIGN_IN_PATH);
    expect(RESET_SIGN_IN_PATH).toBe("/login?reset=done");
  });
});

function renderLogin(search: string): string {
  // wouter reads the bare `location` global; LoginPage reads window.location.
  const location = { pathname: "/login", search, hash: "" };
  vi.stubGlobal("location", location);
  vi.stubGlobal("window", { location });
  return renderToStaticMarkup(<LoginPage onAuthenticated={() => undefined} />);
}

describe("LoginPage reset notice", () => {
  it("shows the notice after a reset that requires sign-in", () => {
    const html = renderLogin("?reset=done");
    expect(html).toContain('role="status"');
    expect(html).toContain("Password changed. Sign in with your new password.");
  });

  it("shows no notice otherwise", () => {
    expect(renderLogin("")).not.toContain("Password changed");
  });
});

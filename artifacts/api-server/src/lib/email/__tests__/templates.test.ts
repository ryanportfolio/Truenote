import { describe, expect, it } from "vitest";
import {
  renderSignInUnavailableNoticeEmail,
  renderSsoInviteEmail,
  renderSsoResetNoticeEmail,
  SSO_SIGN_IN_LABEL
} from "../templates.js";

describe("renderSsoInviteEmail", () => {
  it("links to the sign-in page and names the SSO button", () => {
    const email = renderSsoInviteEmail({
      name: "New Person",
      signInUrl: "https://app.example.com/login"
    });
    expect(SSO_SIGN_IN_LABEL).toBe("Continue with company SSO");
    for (const body of [email.html, email.text]) {
      expect(body).toContain("https://app.example.com/login");
      expect(body).toContain(SSO_SIGN_IN_LABEL);
      expect(body).not.toContain("reset-password");
      expect(body).not.toMatch(/set your password|choose your password/i);
    }
  });

  it("escapes the name and URL in the HTML body", () => {
    const email = renderSsoInviteEmail({
      name: "<b>Eve</b>",
      signInUrl: 'https://app.example.com/login"><script>'
    });
    expect(email.html).not.toContain("<b>Eve</b>");
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;b&gt;Eve&lt;/b&gt;");
  });
});

describe("renderSsoResetNoticeEmail", () => {
  it("points at the sign-in page and carries no reset link", () => {
    const email = renderSsoResetNoticeEmail({
      name: "<b>Eve</b>",
      signInUrl: "https://app.example.com/login"
    });
    for (const body of [email.html, email.text]) {
      expect(body).toContain("https://app.example.com/login");
      expect(body).toContain(SSO_SIGN_IN_LABEL);
      expect(body).not.toContain("reset-password");
    }
    expect(email.html).not.toContain("<b>Eve</b>");
  });
});

describe("renderSignInUnavailableNoticeEmail", () => {
  it("points at an administrator, with no reset or sign-in link", () => {
    const email = renderSignInUnavailableNoticeEmail({ name: "<b>Eve</b>" });
    for (const body of [email.html, email.text]) {
      expect(body).toContain("Contact a Truenote administrator");
      expect(body).not.toContain(SSO_SIGN_IN_LABEL);
      expect(body).not.toContain("reset-password");
      expect(body).not.toContain("/login");
    }
    expect(email.html).not.toContain("<b>Eve</b>");
  });
});

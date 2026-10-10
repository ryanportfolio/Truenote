import { describe, expect, it } from "vitest";
import { renderSsoInviteEmail, SSO_SIGN_IN_LABEL } from "../templates.js";

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

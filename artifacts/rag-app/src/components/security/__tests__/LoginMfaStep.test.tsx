import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MfaRequiredResponse } from "@/types/api";
import { LoginMfaStep } from "../LoginMfaStep";

const noop = () => undefined;

function render(challenge: MfaRequiredResponse): string {
  return renderToStaticMarkup(
    <LoginMfaStep
      challenge={challenge}
      email="emergency@truenote.example"
      onAuthenticated={noop}
      onExpired={noop}
      onCancel={noop}
    />
  );
}

const passkeyOptions = {
  challenge: "Y2hhbGxlbmdl",
  rpId: "app.example.com",
  allowCredentials: [{ id: "Y3JlZA", type: "public-key" as const }],
  userVerification: "required" as const
};

describe("LoginMfaStep", () => {
  it("offers the passkey first and the recovery code behind a link", () => {
    const html = render({ mfaRequired: true, methods: ["passkey", "recovery_code"], passkeyOptions });
    expect(html).toContain("Use passkey");
    expect(html).toContain("Use a recovery code");
    expect(html).not.toContain('id="recovery-code"');
  });

  // The server sends methods ["recovery_code"] and no passkeyOptions when
  // its WebAuthn configuration is unusable (lib/auth/mfa.ts).
  it("shows only the recovery-code form when passkey is not offered", () => {
    const challenge: MfaRequiredResponse = { mfaRequired: true, methods: ["recovery_code"] };
    const html = render(challenge);
    expect(html).not.toContain("Use passkey");
    expect(html).not.toContain("Use a recovery code");
    expect(html).toContain('id="recovery-code"');
    expect(html).toContain("Verify code");
    expect(html).toContain("Passkey sign-in is unavailable on this server");
  });

  it("treats passkey without options as not offered", () => {
    const challenge: MfaRequiredResponse = { mfaRequired: true, methods: ["passkey", "recovery_code"] };
    const html = render(challenge);
    expect(html).not.toContain("Use passkey");
    expect(html).toContain('id="recovery-code"');
  });
});

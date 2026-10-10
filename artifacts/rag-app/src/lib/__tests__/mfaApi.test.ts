import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  login,
  MfaExpiredError,
  removePasskey,
  SESSION_EXPIRED_EVENT,
  UnauthorizedError,
  verifyRecoveryCode
} from "@/lib/api";

const fetchMock = vi.fn();
let sessionExpired = 0;

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

beforeEach(() => {
  sessionExpired = 0;
  const win = Object.assign(new EventTarget(), {
    localStorage: { getItem: () => null }
  });
  win.addEventListener(SESSION_EXPIRED_EVENT, () => {
    sessionExpired += 1;
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const user = {
  id: "u1",
  email: "emergency@example.com",
  role: "super_user",
  programId: null,
  name: "Emergency Admin",
  mustResetPassword: false
};

describe("login()", () => {
  it("returns the user when no second factor is needed", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { user }));
    await expect(login("emergency@example.com", "pw")).resolves.toEqual({
      status: "authenticated",
      user
    });
  });

  it("returns the MFA challenge when the account has a passkey", async () => {
    const challenge = {
      mfaRequired: true,
      methods: ["passkey", "recovery_code"],
      passkeyOptions: { challenge: "abc", allowCredentials: [], rpId: "localhost" }
    };
    fetchMock.mockResolvedValueOnce(reply(200, challenge));
    await expect(login("emergency@example.com", "pw")).resolves.toEqual({
      status: "mfa_required",
      challenge
    });
  });
});

describe("MFA endpoint errors", () => {
  it("turns an expired challenge into MfaExpiredError", async () => {
    fetchMock.mockResolvedValueOnce(
      reply(401, { error: "Your sign-in expired. Enter your email and password again.", code: "mfa_expired" })
    );
    await expect(verifyRecoveryCode("aaaa-bbbb-cccc-dddd")).rejects.toBeInstanceOf(MfaExpiredError);
    expect(sessionExpired).toBe(0);
  });

  it("shows a wrong code inline without ending the session state", async () => {
    fetchMock.mockResolvedValueOnce(reply(401, { error: "Invalid credentials" }));
    await expect(verifyRecoveryCode("aaaa-bbbb-cccc-dddd")).rejects.toThrow("Invalid credentials");
    expect(sessionExpired).toBe(0);
  });

  it("keeps the session on a wrong current password during enrollment", async () => {
    fetchMock.mockResolvedValueOnce(reply(401, { error: "Current password is incorrect" }));
    await expect(removePasskey("pk1", "wrong")).rejects.toThrow("Current password is incorrect");
    expect(sessionExpired).toBe(0);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/mfa/passkeys/pk1");
    expect((init as RequestInit).method).toBe("DELETE");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ password: "wrong" });
  });

  it("fires the session-expired event for a lost session", async () => {
    fetchMock.mockResolvedValueOnce(reply(401, { error: "Unauthorized" }));
    await expect(removePasskey("pk1", "pw")).rejects.toBeInstanceOf(UnauthorizedError);
    expect(sessionExpired).toBe(1);
  });
});

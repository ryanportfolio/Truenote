import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeResetToken } from "@/lib/api";

const fetchMock = vi.fn();

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

beforeEach(() => {
  vi.stubGlobal("window", Object.assign(new EventTarget(), { localStorage: { getItem: () => null } }));
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const user = {
  id: "u1",
  email: "person@example.com",
  role: "csr",
  programId: "p1",
  name: "Person",
  mustResetPassword: false
};

describe("consumeResetToken()", () => {
  it("returns the user when the reset signed the account in", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { user }));
    await expect(consumeResetToken("token-value-long-enough", "new-password")).resolves.toEqual({
      status: "authenticated",
      user
    });
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/auth/reset-password");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(init.body))).toEqual({
      token: "token-value-long-enough",
      newPassword: "new-password"
    });
  });

  it("returns sign_in_required when the account needs a second factor", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { passwordReset: true, signInRequired: true }));
    await expect(consumeResetToken("token-value-long-enough", "new-password")).resolves.toEqual({
      status: "sign_in_required"
    });
  });

  it("throws the server message for a rejected link", async () => {
    fetchMock.mockResolvedValueOnce(reply(400, { error: "This reset link is invalid or has expired" }));
    await expect(consumeResetToken("token-value-long-enough", "new-password")).rejects.toThrow(
      "This reset link is invalid or has expired"
    );
  });
});

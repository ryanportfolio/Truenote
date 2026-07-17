import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetEmailSenderForTests,
  ConsoleEmailSender,
  getEmailSender
} from "../sender.js";

const originalNodeEnv = process.env.NODE_ENV;
const originalApiKey = process.env.RESEND_API_KEY;
const originalFromAddress = process.env.RESEND_FROM_EMAIL;

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  vi.restoreAllMocks();
  restore("NODE_ENV", originalNodeEnv);
  restore("RESEND_API_KEY", originalApiKey);
  restore("RESEND_FROM_EMAIL", originalFromAddress);
  __resetEmailSenderForTests();
});

describe("getEmailSender", () => {
  it("fails closed in production when delivery is not fully configured", () => {
    process.env.NODE_ENV = "production";
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    __resetEmailSenderForTests();

    expect(() => getEmailSender()).toThrow(/both required in production/);
  });

  it("keeps the console sender available for local development", () => {
    process.env.NODE_ENV = "development";
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    __resetEmailSenderForTests();

    expect(getEmailSender()).toBeInstanceOf(ConsoleEmailSender);
  });

  it("JSON-escapes development messages onto one physical log line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const sender = new ConsoleEmailSender();

    await sender.send({
      to: "dev@example.com\n[forged]",
      subject: "Reset\r\n[forged]",
      text: "Open https://example.test/reset?token=dev-only\u2028[forged]",
      html: "<p>not logged</p>"
    });

    expect(log).toHaveBeenCalledOnce();
    const output = String(log.mock.calls[0]?.[0]);
    expect(output).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(output).toContain("\\n[forged]");
    expect(output).toContain("\\r\\n[forged]");
    expect(output).toContain("\\u2028[forged]");
    expect(output).not.toContain("not logged");

  });
});

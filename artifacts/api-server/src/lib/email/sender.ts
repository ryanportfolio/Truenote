/**
 * Transactional email abstraction.
 *
 * Two implementations:
 *   - ResendEmailSender  — production. Wraps the Resend SDK. Used when
 *                          RESEND_API_KEY is set.
 *   - ConsoleEmailSender  — development only. Logs the email payload to
 *                          stdout instead of dispatching. Production
 *                          fails closed when provider configuration is
 *                          absent or incomplete so reset/invite links
 *                          cannot enter deployment logs.
 *
 * The factory `getEmailSender()` picks based on env. Same shape as
 * getObjectStorage() so tests can override via __resetEmailSenderForTests.
 *
 * We intentionally do NOT try to use Resend's React/JSX email templates
 * for the first cut — a hand-written HTML string is enough for password
 * resets, doesn't add a runtime dep, and keeps the email source readable
 * in audit logs.
 */

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailSender {
  send(input: SendEmailInput): Promise<void>;
}

/**
 * Logs the message instead of sending. The plaintext body is the part a
 * developer needs to follow the link, so it goes to stdout in full. JSON
 * encoding keeps user-controlled fields on one physical log line so names,
 * addresses, or body text cannot forge extra console entries. Production
 * never selects this sender.
 */
export class ConsoleEmailSender implements EmailSender {
  async send(input: SendEmailInput): Promise<void> {
    const payload = JSON.stringify({
      to: input.to,
      subject: input.subject,
      text: input.text
    })
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
    console.log(
      `[email] console-fallback (set RESEND_API_KEY to send): ${payload}`
    );
  }
}

/**
 * Minimal subset of the Resend SDK we touch. Declared inline rather
 * than imported so the static type-check passes on the Claude Code
 * sandbox where the package isn't installed.
 */
interface ResendClient {
  emails: {
    send(args: {
      from: string;
      to: string;
      subject: string;
      html: string;
      text: string;
    }): Promise<
      | { error: { message: string; name?: string } | null; data?: unknown }
      | { error?: undefined; data?: unknown }
    >;
  };
}

interface ResendModule {
  Resend: new (apiKey: string) => ResendClient;
}

/**
 * Production sender. Dynamic-import the Resend SDK so an unset env or
 * a missing package doesn't break api-server startup — the failure
 * surfaces at the first send() call with a clear message.
 */
export class ResendEmailSender implements EmailSender {
  private clientPromise: Promise<ResendClient> | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly fromAddress: string
  ) {}

  private async client(): Promise<ResendClient> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        try {
          const mod = (await import("resend")) as ResendModule;
          return new mod.Resend(this.apiKey);
        } catch (err) {
          throw new Error(
            `The 'resend' package is not installed. Install it on Replit. (${String(err)})`
          );
        }
      })();
    }
    return this.clientPromise;
  }

  async send(input: SendEmailInput): Promise<void> {
    const c = await this.client();
    const result = await c.emails.send({
      from: this.fromAddress,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text
    });
    // The Resend SDK surfaces failures as `{ error }` rather than a
    // throw. Promote them so callers don't have to remember to check.
    if ("error" in result && result.error) {
      throw new Error(
        `Resend send failed: ${result.error.message} (${result.error.name ?? "unknown"})`
      );
    }
  }
}

let _sender: EmailSender | null = null;

/**
 * True when a real email provider is configured (both RESEND_API_KEY and
 * RESEND_FROM_EMAIL present). Production callers also receive a fail-closed
 * error from getEmailSender() when this is false.
 */
export function isEmailDeliveryConfigured(): boolean {
  return Boolean(
    process.env.RESEND_API_KEY?.trim() && process.env.RESEND_FROM_EMAIL?.trim()
  );
}

export function getEmailSender(): EmailSender {
  if (_sender) return _sender;
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const fromAddress = process.env.RESEND_FROM_EMAIL?.trim();
  if (apiKey && fromAddress) {
    _sender = new ResendEmailSender(apiKey, fromAddress);
  } else {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "Email delivery is not configured: RESEND_API_KEY and " +
          "RESEND_FROM_EMAIL are both required in production."
      );
    }
    if (apiKey || fromAddress) {
      console.warn(
        "[email] RESEND_API_KEY and RESEND_FROM_EMAIL must both be set to " +
          "use Resend; falling back to console logger."
      );
    }
    _sender = new ConsoleEmailSender();
  }
  return _sender;
}

/** Test-only. */
export function __resetEmailSenderForTests(next?: EmailSender): void {
  _sender = next ?? null;
}

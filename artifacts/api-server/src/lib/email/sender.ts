/**
 * Transactional email abstraction.
 *
 * Two implementations:
 *   - ResendEmailSender  — production. Wraps the Resend SDK. Used when
 *                          RESEND_API_KEY is set.
 *   - ConsoleEmailSender  — dev / fallback. Logs the email payload to
 *                          stdout instead of dispatching. Used when
 *                          RESEND_API_KEY is unset, so a developer
 *                          running locally without an API key still
 *                          sees the reset link in their terminal and
 *                          can click through.
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
 * developer needs to follow the link, so it goes to stdout in full;
 * the HTML is summarized to keep terminal noise reasonable.
 */
export class ConsoleEmailSender implements EmailSender {
  async send(input: SendEmailInput): Promise<void> {
    console.log(
      "[email] (console-fallback — set RESEND_API_KEY to send for real)\n" +
        `  to:      ${input.to}\n` +
        `  subject: ${input.subject}\n` +
        `  text:\n${input.text
          .split("\n")
          .map((line) => "    " + line)
          .join("\n")}`
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

export function getEmailSender(): EmailSender {
  if (_sender) return _sender;
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const fromAddress = process.env.RESEND_FROM_EMAIL?.trim();
  if (apiKey && fromAddress) {
    _sender = new ResendEmailSender(apiKey, fromAddress);
  } else {
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

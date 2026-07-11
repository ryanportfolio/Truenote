import { z } from "zod";

/**
 * Demo-account config parsing. Deliberately free of db/crypto imports so
 * the config route and unit tests can use it without side effects; the
 * DB work lives in bootstrap-demo.ts.
 *
 * DEMO_LOGIN_ACCOUNTS (Replit Secrets) is a JSON array:
 *
 *   [{"label":"Manager","email":"manager@demo.truenote","password":"...","role":"manager"},
 *    {"label":"CSR","email":"csr@demo.truenote","password":"..."}]
 *
 * SECURITY: everything in this variable is PUBLISHED to anyone who can
 * reach the deployment — /api/config (unauthenticated) returns it so the
 * login page can pre-fill credentials. That is the feature: a demo
 * deployment anyone can try. Never set this on a deployment holding real
 * content. Roles are capped at "manager" by the schema below, so a
 * leaked demo deployment can never hand out user-management or
 * cross-program (super_user) capability.
 */
const DemoAccountSchema = z.object({
  label: z.string().min(1).max(40),
  email: z.string().email(),
  password: z.string().min(1),
  role: z.enum(["csr", "manager"]).default("csr"),
  /** Program the account is scoped to; created if missing. */
  program: z.string().min(1).default("Demo Program")
});

const DemoAccountsSchema = z.array(DemoAccountSchema).min(1).max(4);

export type DemoAccount = z.infer<typeof DemoAccountSchema>;

/** Shape exposed on /api/config — no role/program internals needed there. */
export interface PublicDemoAccount {
  label: string;
  email: string;
  password: string;
}

/**
 * Parse a DEMO_LOGIN_ACCOUNTS value. Returns null when unset, empty, or
 * invalid — an invalid value logs once and behaves like "no demo mode"
 * rather than taking the api-server down.
 */
export function parseDemoAccounts(raw: string | undefined): DemoAccount[] | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const parsed = DemoAccountsSchema.safeParse(JSON.parse(trimmed));
    if (!parsed.success) {
      console.warn(
        "[demo-accounts] DEMO_LOGIN_ACCOUNTS is set but invalid — ignoring.",
        parsed.error.issues.map((i) => i.message).join("; ")
      );
      return null;
    }
    return parsed.data;
  } catch {
    console.warn("[demo-accounts] DEMO_LOGIN_ACCOUNTS is not valid JSON — ignoring.");
    return null;
  }
}

export function getDemoAccounts(): DemoAccount[] | null {
  return parseDemoAccounts(process.env.DEMO_LOGIN_ACCOUNTS);
}

/**
 * Demo accounts are shared, publicly-credentialed users — anyone on the
 * internet is "logged in" as them. Mutations that would degrade the demo
 * for the next visitor (uploading/deleting documents, editing users,
 * rotating the published password) are refused with this message. The
 * env var doesn't change within a process in practice, but tests swap it
 * per-case, so the cache is keyed on the raw value rather than
 * computed once at module load.
 */
let demoEmailCache: { raw: string | undefined; set: Set<string> } | null =
  null;

export function getDemoEmailSet(): Set<string> {
  const raw = process.env.DEMO_LOGIN_ACCOUNTS;
  if (!demoEmailCache || demoEmailCache.raw !== raw) {
    const accounts = parseDemoAccounts(raw);
    demoEmailCache = {
      raw,
      set: new Set((accounts ?? []).map((a) => a.email.toLowerCase()))
    };
  }
  return demoEmailCache.set;
}

export function isDemoEmail(email: string): boolean {
  return getDemoEmailSet().has(email.toLowerCase());
}

export function toPublicDemoAccounts(accounts: DemoAccount[]): PublicDemoAccount[] {
  return accounts.map(({ label, email, password }) => ({ label, email, password }));
}

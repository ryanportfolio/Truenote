import { runAiSecurityRegression } from "./ai-security-regression.js";

interface CliArgs {
  baseUrl?: string;
  environment?: string;
  programId?: string;
  release?: string;
  confirmSynthetic: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { confirmSynthetic: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base-url") args.baseUrl = argv[++index];
    else if (arg === "--environment") args.environment = argv[++index];
    else if (arg === "--program") args.programId = argv[++index];
    else if (arg === "--release") args.release = argv[++index];
    else if (arg === "--confirm-synthetic") args.confirmSynthetic = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function help(): void {
  process.stdout.write(`Usage: pnpm --filter @workspace/scripts run security:ai-canary -- [options]

Required:
  --base-url <https-url>       Authorized Truenote test target
  --environment <label>       Non-secret environment/evidence label
  --confirm-synthetic          Confirms fixed synthetic cases may be submitted
  TRUENOTE_SECURITY_TEST_SESSION_TOKEN  Authenticated non-production test token

Optional:
  --program <uuid>             Required when the test account is a super user
  --release <sha/version>      Release identity stored in the sanitized report

The command spends provider calls. It writes sanitized JSON to stdout only and
never includes prompts, answers, canary values, or the session token.
`);
}

function validateBaseUrl(raw: string): URL {
  const url = new URL(raw);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("AI security target must use HTTPS (HTTP allowed only for localhost). ");
  }
  if (url.username || url.password) {
    throw new Error("Do not place credentials in the AI security target URL.");
  }
  return url;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    help();
    return;
  }
  if (!args.confirmSynthetic) throw new Error("--confirm-synthetic is required");
  if (!args.baseUrl) throw new Error("--base-url is required");
  if (!args.environment) throw new Error("--environment is required");
  const token = process.env.TRUENOTE_SECURITY_TEST_SESSION_TOKEN?.trim();
  if (!token) throw new Error("TRUENOTE_SECURITY_TEST_SESSION_TOKEN is required");
  const baseUrl = validateBaseUrl(args.baseUrl);

  const report = await runAiSecurityRegression({
    baseUrl: baseUrl.origin,
    environment: args.environment,
    sessionToken: token,
    ...(args.programId ? { programId: args.programId } : {}),
    ...(args.release ? { release: args.release } : {})
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.allPassed) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "AI security canary failed"}\n`
  );
  process.exitCode = 1;
});

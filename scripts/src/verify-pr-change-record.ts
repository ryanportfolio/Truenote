import { readFileSync } from "node:fs";
import { isAutomatedDependencyUpdate, verifyChangeRecord } from "./change-record.js";

interface PullRequestEvent {
  pull_request?: { body?: unknown; user?: { login?: unknown } };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readEvent(): PullRequestEvent | null {
  const eventPath = argument("--event") ?? process.env.GITHUB_EVENT_PATH;
  return eventPath ? (JSON.parse(readFileSync(eventPath, "utf8")) as PullRequestEvent) : null;
}

function readBody(event: PullRequestEvent | null): string {
  const bodyPath = argument("--body");
  if (bodyPath) return readFileSync(bodyPath, "utf8");

  if (!event) throw new Error("provide --body, --event, or GITHUB_EVENT_PATH");
  if (typeof event.pull_request?.body !== "string") {
    throw new Error("GitHub event does not contain a pull-request body");
  }
  return event.pull_request.body;
}

// One path per line, as printed by `git diff --name-only`.
function readChangedFiles(): string[] {
  const listPath = argument("--changed-files");
  if (!listPath) return [];
  return readFileSync(listPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function main(): void {
  const event = readEvent();
  const author = event?.pull_request?.user?.login;
  if (typeof author === "string" && isAutomatedDependencyUpdate(author, readChangedFiles())) {
    console.log(
      "Pull-request change record not required: automated dependency update (configuration management procedure, section 6.1)."
    );
    return;
  }

  const result = verifyChangeRecord(readBody(event), {
    allowPendingApproval: process.argv.includes("--allow-pending")
  });
  if (result.issues.length > 0) {
    console.error("Pull-request change record failed:");
    for (const issue of result.issues) console.error(`- ${issue}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Pull-request change record passed: ${result.changeId}`);
}

main();

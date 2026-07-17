import { readFileSync } from "node:fs";
import { verifyChangeRecord } from "./change-record.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readBody(): string {
  const bodyPath = argument("--body");
  if (bodyPath) return readFileSync(bodyPath, "utf8");

  const eventPath = argument("--event") ?? process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("provide --body, --event, or GITHUB_EVENT_PATH");
  const event = JSON.parse(readFileSync(eventPath, "utf8")) as {
    pull_request?: { body?: unknown };
  };
  if (typeof event.pull_request?.body !== "string") {
    throw new Error("GitHub event does not contain a pull-request body");
  }
  return event.pull_request.body;
}

function main(): void {
  const result = verifyChangeRecord(readBody());
  if (result.issues.length > 0) {
    console.error("Pull-request change record failed:");
    for (const issue of result.issues) console.error(`- ${issue}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Pull-request change record passed: ${result.changeId}`);
}

main();

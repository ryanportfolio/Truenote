// Rebuild the generated demo files in docs/demo-kb/files/.
// Usage (repo root, Windows): node docs/demo-kb/source/build.mjs
// Needs Google Chrome, and Python with python-docx and Pillow (`py` launcher).
// The two AI-generated images are not rebuilt here; see ../README.md.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const files = path.resolve(here, "../files");
const tmp = path.resolve(here, "../../../.tmp/demo-kb-build");
mkdirSync(files, { recursive: true });
mkdirSync(tmp, { recursive: true });

const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: process.env });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
}

const chrome = (extra, html) =>
  run(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--user-data-dir=${path.join(tmp, "chrome-profile")}`,
    ...extra,
    pathToFileURL(path.join(here, html)).href
  ]);

const pdf = (html, out) =>
  chrome([`--print-to-pdf=${path.join(files, out)}`, "--no-pdf-header-footer"], html);
const shot = (html, out, w, h) =>
  chrome([`--screenshot=${out}`, `--window-size=${w},${h}`], html);

pdf("cancellation-policy.html", "cancellation-policy.pdf");
pdf("plans-and-pricing.html", "plans-and-pricing.pdf");
pdf("privacy-requests.html", "privacy-requests.pdf");

shot("billing-console-refund.html", path.join(files, "billing-console-refund.png"), 1440, 900);
shot("payment-decline-codes.html", path.join(tmp, "decline.png"), 1280, 520);
shot("pin-change-memo.html", path.join(tmp, "memo.png"), 1275, 1650);

run("py", [path.join(here, "build_docx.py"), files]);
run("py", [path.join(here, "build_images.py"), tmp, files]);

rmSync(path.join(tmp, "chrome-profile"), { recursive: true, force: true });
console.log(`built into ${files}`);

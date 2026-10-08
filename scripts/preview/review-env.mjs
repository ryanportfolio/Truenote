// Starts the fixture API and the SPA on Vite proxying /api to it.
// Ports: MOCK_PORT (default 5099) and VITE_PORT (default 5180). Stopping this process stops both.
// Parallel reviewers each run their own pair so fixture state is never shared.
// What this proves and what it does not: scripts/preview/mock-api/README.md.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const mockPort = process.env.MOCK_PORT ?? "5099";
const vitePort = process.env.VITE_PORT ?? "5180";
const windows = process.platform === "win32";
const procs = [];
let stopping = false;

function run(cmd, args, env, { shell = false } = {}) {
  // Off Windows each child leads its own process group, so the whole tree can be signaled.
  const p = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: "inherit", shell, detached: !windows });
  procs.push(p);
  p.on("exit", (code) => {
    console.log(`[review-env] ${cmd} exited ${code}`);
    shutdown();
  });
}

/** Ends a child and everything it started (a shell wrapper alone would leave the server running). */
function killTree(p) {
  if (p.exitCode !== null || p.signalCode !== null || p.pid === undefined) return;
  if (windows) {
    spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-p.pid, "SIGTERM");
    } catch {
      p.kill("SIGTERM");
    }
  }
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) killTree(p);
  process.exitCode = 0;
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", shutdown);

run(process.execPath, ["scripts/preview/mock-api/server.mjs"], { MOCK_PORT: mockPort, PORT: vitePort });
// corepack is a .cmd shim on Windows, which needs a shell to start.
run("corepack", ["pnpm", "--filter", "@workspace/rag-app", "run", "dev", "--", "--port", vitePort, "--strictPort"], { API_PORT: mockPort, PORT: vitePort }, { shell: windows });

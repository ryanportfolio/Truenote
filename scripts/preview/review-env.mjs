// Starts the fixture API and the SPA on Vite proxying /api to it.
// Ports: MOCK_PORT (default 5099) and VITE_PORT (default 5180). Kill this process to stop both.
// Parallel reviewers each run their own pair so fixture state is never shared.
// What this proves and what it does not: scripts/preview/mock-api/README.md.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const mockPort = process.env.MOCK_PORT ?? "5099";
const vitePort = process.env.VITE_PORT ?? "5180";
const procs = [];
function run(cmd, args, env) {
  const p = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: "inherit", shell: true });
  procs.push(p);
  p.on("exit", (code) => { console.log(`[review-env] ${cmd} exited ${code}`); shutdown(); });
}
function shutdown() { for (const p of procs) if (!p.killed) p.kill(); process.exitCode = 0; }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

run("node", ["scripts/preview/mock-api/server.mjs"], { MOCK_PORT: mockPort, PORT: vitePort });
run("corepack", ["pnpm", "--filter", "@workspace/rag-app", "run", "dev", "--", "--port", vitePort, "--strictPort"], { API_PORT: mockPort, PORT: vitePort });

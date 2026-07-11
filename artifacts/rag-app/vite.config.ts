import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { brotliCompress, constants, gzip } from "node:zlib";
import { promisify } from "node:util";

const brotli = promisify(brotliCompress);
const gzipFile = promisify(gzip);

/**
 * Replit currently serves production assets without transport compression.
 * Prebuild both modern Brotli and gzip variants using Node's built-ins; the
 * API server negotiates these files before falling back to the originals.
 */
function precompressAssets() {
  return {
    name: "precompress-assets",
    apply: "build" as const,
    async closeBundle(): Promise<void> {
      const assetsDir = path.resolve(__dirname, "dist/assets");
      const entries = await readdir(assetsDir, { withFileTypes: true });
      await Promise.all(
        entries
          .filter(
            (entry) =>
              entry.isFile() && /\.(?:css|js|json|svg)$/.test(entry.name)
          )
          .map(async (entry) => {
            const filePath = path.join(assetsDir, entry.name);
            const source = await readFile(filePath);
            if (source.length < 1024) return;
            const [br, gz] = await Promise.all([
              brotli(source, {
                params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
              }),
              gzipFile(source, { level: 9 })
            ]);
            await Promise.all([
              writeFile(`${filePath}.br`, br),
              writeFile(`${filePath}.gz`, gz)
            ]);
          })
      );
    }
  };
}

// API server we proxy /api to. API_PORT is set in .replit and at the
// workspace root so both processes agree without each having its own copy.
const API_PORT = Number(process.env.API_PORT) || 5000;
const FRONTEND_PORT = Number(process.env.PORT) || 5173;

export default defineConfig({
  plugins: [react(), precompressAssets()],
  base: "/",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src")
    }
  },
  server: {
    host: "0.0.0.0",
    port: FRONTEND_PORT,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true
      }
    }
  },
  preview: {
    host: "0.0.0.0",
    port: FRONTEND_PORT,
    allowedHosts: true
  }
});

import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { brotliCompress, constants, gzip } from "node:zlib";
import { promisify } from "node:util";

const brotli = promisify(brotliCompress);
const gzipFile = promisify(gzip);

const securityPagePath = path.resolve(
  __dirname,
  "../../docs/security/truenote-security-capabilities.html"
);

async function loadSecurityPage(): Promise<{ html: string; css: string }> {
  const source = await readFile(securityPagePath, "utf8");
  const styleMatch = source.match(/<style>([\s\S]*?)<\/style>/);
  const css = styleMatch?.[1];
  if (!styleMatch || css === undefined) {
    throw new Error("Security page must contain one embedded style block.");
  }

  return {
    html: source.replace(
      styleMatch[0],
      '<link rel="stylesheet" href="/security/styles.css">'
    ),
    css: css.trim()
  };
}

/**
 * Keep the reviewable standalone document as the only content source while
 * publishing CSP-compatible assets at /security/ in development and builds.
 */
function publishSecurityPage(): Plugin {
  return {
    name: "publish-security-page",
    configureServer(server): void {
      server.middlewares.use((req, res, next) => {
        const pathname = req.url?.split("?", 1)[0];
        if (
          pathname !== "/security" &&
          pathname !== "/security/" &&
          pathname !== "/security/styles.css"
        ) {
          next();
          return;
        }

        void loadSecurityPage()
          .then(({ html, css }) => {
            res.statusCode = 200;
            res.setHeader(
              "Content-Type",
              pathname === "/security/styles.css"
                ? "text/css; charset=utf-8"
                : "text/html; charset=utf-8"
            );
            res.end(pathname === "/security/styles.css" ? css : html);
          })
          .catch(next);
      });
    },
    async generateBundle(): Promise<void> {
      const { html, css } = await loadSecurityPage();
      this.emitFile({
        type: "asset",
        fileName: "security/index.html",
        source: html
      });
      this.emitFile({
        type: "asset",
        fileName: "security/styles.css",
        source: css
      });
    }
  };
}

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
  plugins: [react(), publishSecurityPage(), precompressAssets()],
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
        changeOrigin: true,
        // Preserve the browser-facing host/protocol for the API's mutation
        // Origin check. Replit exposes Vite publicly and keeps API_PORT
        // internal, so the rewritten Host alone is not the trusted origin.
        xfwd: true
      }
    }
  },
  preview: {
    host: "0.0.0.0",
    port: FRONTEND_PORT,
    allowedHosts: true
  }
});

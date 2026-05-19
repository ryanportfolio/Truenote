import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// API server we proxy /api to. API_PORT is set in .replit and at the
// workspace root so both processes agree without each having its own copy.
const API_PORT = Number(process.env.API_PORT) || 5000;
const FRONTEND_PORT = Number(process.env.PORT) || 5173;

export default defineConfig({
  plugins: [react()],
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

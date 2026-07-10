import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1rem",
      screens: { "2xl": "1400px" }
    },
    extend: {
      fontFamily: {
        // Verdana carries the UI (deliberate: system face, zero network load).
        // Georgia — Verdana's Matthew Carter companion — is reserved for big
        // headers and distinctive elements (page h1s, wordmark, login title).
        sans: ["Verdana", "Geneva", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["Georgia", "Cambria", "'Times New Roman'", "serif"],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "'Liberation Mono'",
          "monospace"
        ]
      },
      colors: {
        border: "oklch(var(--border) / <alpha-value>)",
        input: "oklch(var(--input) / <alpha-value>)",
        ring: "oklch(var(--ring) / <alpha-value>)",
        background: "oklch(var(--background) / <alpha-value>)",
        foreground: "oklch(var(--foreground) / <alpha-value>)",
        primary: {
          DEFAULT: "oklch(var(--primary) / <alpha-value>)",
          foreground: "oklch(var(--primary-foreground) / <alpha-value>)"
        },
        secondary: {
          DEFAULT: "oklch(var(--secondary) / <alpha-value>)",
          foreground: "oklch(var(--secondary-foreground) / <alpha-value>)"
        },
        muted: {
          DEFAULT: "oklch(var(--muted) / <alpha-value>)",
          foreground: "oklch(var(--muted-foreground) / <alpha-value>)"
        },
        accent: {
          DEFAULT: "oklch(var(--accent) / <alpha-value>)",
          foreground: "oklch(var(--accent-foreground) / <alpha-value>)"
        },
        destructive: {
          DEFAULT: "oklch(var(--destructive) / <alpha-value>)",
          foreground: "oklch(var(--destructive-foreground) / <alpha-value>)"
        },
        card: {
          DEFAULT: "oklch(var(--card) / <alpha-value>)",
          foreground: "oklch(var(--card-foreground) / <alpha-value>)"
        },
        warning: {
          DEFAULT: "oklch(var(--warning) / <alpha-value>)",
          foreground: "oklch(var(--warning-foreground) / <alpha-value>)"
        },
        success: {
          DEFAULT: "oklch(var(--success) / <alpha-value>)",
          foreground: "oklch(var(--success-foreground) / <alpha-value>)"
        }
      },
      boxShadow: {
        card: "var(--shadow-card)",
        panel: "var(--shadow-panel)"
      },
      // Skeleton loading pulse: slow opacity breathing, no shimmer sweep —
      // calm register. Consumed via .skeleton in index.css, motion-safe only.
      keyframes: {
        "skeleton-pulse": {
          "50%": { opacity: "0.55" }
        },
        // Boot mark draw-in: the superellipse strokes itself (pathLength=1
        // normalizes the dash math), then the ink fill fades up under it.
        "mark-draw": {
          from: { strokeDashoffset: "1" },
          to: { strokeDashoffset: "0" }
        },
        "mark-ink": {
          from: { opacity: "0" },
          to: { opacity: "1" }
        },
        // Empty-state blob drift: two ultra-slow amoebic wanders. Transform
        // only, amplitudes of a few px — ambient material, not motion.
        "blob-drift-a": {
          "0%, 100%": { transform: "translate3d(0, 0, 0) scale(1)" },
          "33%": { transform: "translate3d(7px, -5px, 0) scale(1.08)" },
          "66%": { transform: "translate3d(-5px, 4px, 0) scale(0.95)" }
        },
        "blob-drift-b": {
          "0%, 100%": { transform: "translate3d(0, 0, 0) scale(1)" },
          "40%": { transform: "translate3d(-6px, -4px, 0) scale(0.94)" },
          "70%": { transform: "translate3d(5px, 5px, 0) scale(1.07)" }
        },
        // Receipt reveal: the grounding eyebrow arrives a beat after the
        // answer card — the receipt printing under the total.
        "receipt-in": {
          from: { opacity: "0", transform: "translateY(3px)" },
          to: { opacity: "1", transform: "translateY(0)" }
        }
      },
      animation: {
        skeleton: "skeleton-pulse 1.8s ease-in-out infinite",
        "mark-draw": "mark-draw 0.9s cubic-bezier(0.25, 1, 0.5, 1) both",
        "mark-ink": "mark-ink 0.5s cubic-bezier(0.25, 1, 0.5, 1) 0.55s both",
        "blob-drift-a": "blob-drift-a 26s ease-in-out infinite",
        "blob-drift-b": "blob-drift-b 34s ease-in-out infinite",
        "receipt-in": "receipt-in 0.24s cubic-bezier(0.25, 1, 0.5, 1) 0.18s both"
      },
      // DESIGN.md §Motion tokens — tailwindcss-animate maps these scales onto
      // animation-timing-function / animation-duration too, so ease-out-quart
      // and duration-240 work for both transitions and animate-in entrances.
      transitionTimingFunction: {
        "out-quart": "cubic-bezier(0.25, 1, 0.5, 1)"
      },
      transitionDuration: {
        "240": "240ms"
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)"
      }
    }
  },
  plugins: [require("tailwindcss-animate")]
};

export default config;

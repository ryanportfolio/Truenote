import { memo, useId, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { cn } from "@/lib/utils";
import type { DemoAccount } from "@/types/api";

/**
 * One demo-account portal on the login page: a miniature of the Luminous
 * Archive hero (DESIGN.md §Brand moments). Grid-paper and mineral rings
 * sit around a recessed cobalt core, each ring with one main gap.
 *
 *   rest      gaps scattered; the rings sit at role-specific offsets
 *   hover     the card lifts, layers parallax toward the pointer by depth,
 *             and the rings turn part of the way toward alignment
 *   selected  evidence flecks gather into the core, it flashes, and every
 *             gap locks onto one axis that points at the label; a cobalt
 *             reading beam runs through the channel
 *
 * The rotations live in CSS (`--k` scales each ring's offset: 1 at rest,
 * a fraction on hover, 0 when selected), so reduced motion and low-power
 * rules stay in index.css. Pointer position reaches CSS as `--px`/`--py`
 * (-1..1) and `--mx`/`--my` without a React render, written only on the
 * layers and light spans that read them, so a pointer move restyles those
 * few elements instead of the whole SVG.
 */

type Role = DemoAccount["role"];

interface RoleArt {
  /** Rest offsets in degrees, per ring, from the aligned angle (register: from --reg). */
  offsets: { inner: number; mineral: number; outer: number; register: number };
  /** Narrow seams, degrees in each ring's own frame (main gap sits at 0). */
  seams: { inner: number[]; mineral: number[]; outer: number[] };
  /** Outer sectors (by index) pulled out past the ring, like the hero's tabs. */
  tabs: number[];
  /** Persimmon register bars. */
  bars: number;
}

const ROLE_ART: Record<Role, RoleArt> = {
  csr: {
    offsets: { inner: 118, mineral: -96, outer: 64, register: -10 },
    seams: { inner: [130, 250], mineral: [200], outer: [95, 170, 290] },
    tabs: [1],
    bars: 1
  },
  supervisor: {
    offsets: { inner: -132, mineral: 84, outer: -70, register: 9 },
    seams: { inner: [100, 220, 300], mineral: [150, 260], outer: [60, 200] },
    tabs: [2],
    bars: 2
  },
  manager: {
    offsets: { inner: 96, mineral: 140, outer: -112, register: -7 },
    seams: { inner: [180], mineral: [110, 230, 300], outer: [80, 150, 240, 310] },
    tabs: [0, 3],
    bars: 3
  }
};

const C = 100;
const GAP = { inner: 18, mineral: 16, outer: 14 };
const SEAM = 2.4;
const R = {
  core: 21,
  bezel: 27,
  inner: [30, 39] as const,
  mineral: [42, 57] as const,
  outer: [60, 78] as const,
  tab: 81,
  bars: [
    [80.5, 85.5],
    [87, 92],
    [93.5, 98.5]
  ] as const
};

function polar(r: number, deg: number): string {
  const a = (deg * Math.PI) / 180;
  return `${(C + r * Math.cos(a)).toFixed(2)} ${(C + r * Math.sin(a)).toFixed(2)}`;
}

function sector(r0: number, r1: number, a0: number, a1: number): string {
  const large = a1 - a0 > 180 ? 1 : 0;
  return (
    `M${polar(r1, a0)}A${r1} ${r1} 0 ${large} 1 ${polar(r1, a1)}` +
    `L${polar(r0, a1)}A${r0} ${r0} 0 ${large} 0 ${polar(r0, a0)}Z`
  );
}

function arc(r: number, a0: number, a1: number): string {
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${polar(r, a0)}A${r} ${r} 0 ${large} 1 ${polar(r, a1)}`;
}

/** Sector spans for a ring whose main gap is centered on 0deg. */
function spans(gap: number, seams: number[]): Array<[number, number]> {
  const cuts = [...seams].sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  let start = gap / 2;
  for (const s of cuts) {
    out.push([start, s - SEAM / 2]);
    start = s + SEAM / 2;
  }
  out.push([start, 360 - gap / 2]);
  return out;
}

/** Fine polar grid (radial ticks + concentric hairlines) clipped to the spans. */
function polarGrid(r0: number, r1: number, parts: Array<[number, number]>, step: number): string {
  let d = "";
  for (const [a0, a1] of parts) {
    for (let a = a0 + step / 2; a < a1; a += step) {
      d += `M${polar(r0 + 0.6, a)}L${polar(r1 - 0.6, a)}`;
    }
    const rings = Math.max(1, Math.round((r1 - r0) / 4.5) - 1);
    for (let i = 1; i <= rings; i++) {
      d += arc(r0 + ((r1 - r0) * i) / (rings + 1), a0 + 0.4, a1 - 0.4);
    }
  }
  return d;
}

interface RingGeometry {
  parts: Array<[number, number]>;
  grid: string;
}

function ring(r0: number, r1: number, gap: number, seams: number[], step: number): RingGeometry {
  const parts = spans(gap, seams);
  return { parts, grid: polarGrid(r0, r1, parts, step) };
}

interface RoleGeometry {
  inner: RingGeometry;
  mineral: RingGeometry;
  outer: RingGeometry;
  /** Outline of each ring's sectors as one path: shadow copy and edge. */
  outlines: { inner: string; mineral: string; outer: string };
}

function outline(parts: Array<[number, number]>, r0: number, r1: number, tabs: number[] = []): string {
  return parts.map(([a0, a1], i) => sector(r0, tabs.includes(i) ? R.tab : r1, a0, a1)).join("");
}

function roleGeometry(art: RoleArt): RoleGeometry {
  const inner = ring(R.inner[0], R.inner[1], GAP.inner, art.seams.inner, 6);
  const mineral = ring(R.mineral[0], R.mineral[1], GAP.mineral, art.seams.mineral, 5);
  const outer = ring(R.outer[0], R.outer[1], GAP.outer, art.seams.outer, 4.5);
  return {
    inner,
    mineral,
    outer,
    outlines: {
      inner: outline(inner.parts, R.inner[0], R.inner[1]),
      mineral: outline(mineral.parts, R.mineral[0], R.mineral[1]),
      outer: outline(outer.parts, R.outer[0], R.outer[1], art.tabs)
    }
  };
}

// Built once per role at module load; renders reuse the path strings.
const GEOMETRY = Object.fromEntries(
  (Object.keys(ROLE_ART) as Role[]).map((role) => [role, roleGeometry(ROLE_ART[role])])
) as Record<Role, RoleGeometry>;

/** Lens rings inside the core: concentric arcs with breaks, as in the hero. */
const LENS = [
  arc(8.5, 20, 330),
  arc(12.8, 120, 400),
  arc(16.6, 210, 470),
  arc(16.6, 488, 540)
].join("");

const STARS: Array<[number, number, number]> = [
  [-9, -6, 0.55],
  [6, -11, 0.4],
  [11, 4, 0.5],
  [-4, 9, 0.35],
  [-13, 3, 0.3],
  [3, 2, 0.6],
  [8, 12, 0.3]
];

const FLECKS = [6, 34, 63, 92, 118, 149, 178, 205, 236, 262, 293, 322];

interface DemoPortalProps {
  account: DemoAccount;
  selected: boolean;
  disabled: boolean;
  className?: string;
  onSelect: (account: DemoAccount) => void;
}

export const DemoPortal = memo(function DemoPortal({
  account,
  selected,
  disabled,
  className,
  onSelect
}: DemoPortalProps): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);
  const frame = useRef(0);
  const targets = useRef<{ layers: Array<SVGGElement>; lights: Array<HTMLSpanElement> } | null>(null);
  // Each selection replays the gather + shockwave by remounting them.
  const [burst, setBurst] = useState(0);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const id = (name: string): string => `pp${uid}${name}`;
  const role: Role = account.role in ROLE_ART ? account.role : "csr";
  const art = ROLE_ART[role];
  const { inner, mineral, outer, outlines } = GEOMETRY[role];

  function lightTargets(el: HTMLButtonElement) {
    targets.current ??= {
      layers: Array.from(el.querySelectorAll<SVGGElement>(".pp-layer")),
      lights: Array.from(el.querySelectorAll<HTMLSpanElement>(".pp-rim, .pp-sheen"))
    };
    return targets.current;
  }

  function track(e: PointerEvent<HTMLButtonElement>): void {
    if (e.pointerType === "touch" || disabled) return;
    const el = ref.current;
    if (!el) return;
    const { clientX, clientY } = e;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      const y = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
      const { layers, lights } = lightTargets(el);
      const px = (x * 2 - 1).toFixed(3);
      const py = (y * 2 - 1).toFixed(3);
      for (const layer of layers) {
        layer.style.setProperty("--px", px);
        layer.style.setProperty("--py", py);
      }
      for (const light of lights) {
        light.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
        light.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
      }
    });
  }

  function release(): void {
    cancelAnimationFrame(frame.current);
    const el = ref.current;
    if (!el) return;
    for (const layer of lightTargets(el).layers) {
      layer.style.setProperty("--px", "0");
      layer.style.setProperty("--py", "0");
    }
  }

  function paperSectors(
    parts: Array<[number, number]>,
    r0: number,
    r1: number,
    tabs: number[] = []
  ): JSX.Element[] {
    return parts.map(([a0, a1], i) => (
      <path
        key={i}
        d={sector(r0, tabs.includes(i) ? R.tab : r1, a0, a1)}
        fill={`url(#${id(i % 2 ? "paperB" : "paperA")})`}
      />
    ));
  }

  const spin = (offset: number, delay: number) =>
    ({ "--off": `${offset}deg`, "--delay": `${delay}ms` }) as CSSProperties;

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => {
        onSelect(account);
        setBurst((n) => n + 1);
      }}
      onPointerMove={track}
      onPointerLeave={release}
      aria-pressed={selected}
      aria-label={`Use the ${account.label} demo`}
      disabled={disabled}
      className={cn(
        "auth-demo-role",
        selected && "auth-demo-role-active",
        account.label.length > 12 && "auth-demo-role-long",
        className
      )}
    >
      <span className="pp-rim" aria-hidden />
      <span className="pp-sheen" aria-hidden />
      <svg className="pp-art" viewBox="0 0 200 200" aria-hidden focusable="false">
        <defs>
          <linearGradient id={id("paperA")} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" className="pp-stop-card" />
            <stop offset="1" className="pp-stop-paper" />
          </linearGradient>
          <linearGradient id={id("paperB")} x1="1" y1="0" x2="0" y2="1">
            <stop offset="0" className="pp-stop-paper" />
            <stop offset="1" className="pp-stop-paper-deep" />
          </linearGradient>
          <radialGradient id={id("mineral")} cx="0.38" cy="0.32" r="0.8">
            <stop offset="0" className="pp-stop-mineral-light" />
            <stop offset="0.55" className="pp-stop-mineral" />
            <stop offset="1" className="pp-stop-mineral-deep" />
          </radialGradient>
          <radialGradient id={id("mottle")} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" className="pp-stop-mottle" />
            <stop offset="1" className="pp-stop-mottle-clear" />
          </radialGradient>
          <radialGradient id={id("bezel")} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0.74" className="pp-stop-paper-deep" />
            <stop offset="0.86" className="pp-stop-card" />
            <stop offset="1" className="pp-stop-paper" />
          </radialGradient>
          <radialGradient id={id("glass")} cx="0.46" cy="0.44" r="0.58" fx="0.4" fy="0.36">
            <stop offset="0" className="pp-stop-glass-hot" />
            <stop offset="0.38" className="pp-stop-glass" />
            <stop offset="0.8" className="pp-stop-glass-deep" />
            <stop offset="1" className="pp-stop-glass-edge" />
          </radialGradient>
          <radialGradient id={id("flash")} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" className="pp-stop-flash" />
            <stop offset="0.45" className="pp-stop-flash-mid" />
            <stop offset="1" className="pp-stop-flash-clear" />
          </radialGradient>
          <linearGradient id={id("streak")} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0.2" className="pp-stop-streak-clear" />
            <stop offset="0.5" className="pp-stop-streak" />
            <stop offset="0.8" className="pp-stop-streak-clear" />
          </linearGradient>
          <linearGradient id={id("beam")} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" className="pp-stop-beam" />
            <stop offset="0.55" className="pp-stop-beam-mid" />
            <stop offset="1" className="pp-stop-beam-clear" />
          </linearGradient>
          <radialGradient id={id("halo")} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0.5" className="pp-stop-halo" />
            <stop offset="1" className="pp-stop-halo-clear" />
          </radialGradient>
          <clipPath id={id("glassClip")}>
            <circle cx={C} cy={C} r={R.core} />
          </clipPath>
          <clipPath id={id("mineralClip")}>
            {mineral.parts.map(([a0, a1], i) => (
              <path key={i} d={sector(R.mineral[0], R.mineral[1], a0, a1)} />
            ))}
          </clipPath>
        </defs>

        {/* Pencil construction: drafting arcs, crosshair and ticks, open
          * toward the label (local 0deg is --align). */}
        <g className="pp-layer pp-depth-0">
          <g className="pp-pencil-axis">
            <path className="pp-pencil" d={arc(112, 48, 312)} pathLength={1} />
            <path className="pp-pencil" d={arc(138, 52, 308)} pathLength={1} />
            <path className="pp-pencil" d={`M${polar(150, 45)}L${polar(150, 225)}`} pathLength={1} />
            <path className="pp-pencil" d={`M${polar(150, 315)}L${polar(150, 135)}`} pathLength={1} />
            <path
              className="pp-ticks"
              d={Array.from({ length: 19 }, (_, i) => 50 + i * 14)
                .map((a, i) => `M${polar(108, a)}L${polar(i % 2 ? 112 : 116, a)}`)
                .join("")}
            />
          </g>
        </g>

        {/* Persimmon register bars. */}
        <g className="pp-layer pp-depth-5">
          <g className="pp-spin pp-spin-register" style={spin(art.offsets.register, 150)}>
            {R.bars.slice(0, art.bars).map(([r0, r1], i) => (
              <path key={i} className="pp-bar" d={sector(r0, r1, -13 + i * 2, 11 - i * 3)} />
            ))}
          </g>
        </g>

        {/* Outer grid-paper ring, with pulled-out tabs. */}
        <g className="pp-layer pp-depth-4">
          <g className="pp-shadow-offset">
            <g className="pp-spin" style={spin(art.offsets.outer, 100)}>
              <path className="pp-shadow" d={outlines.outer} />
            </g>
          </g>
          <g className="pp-spin" style={spin(art.offsets.outer, 100)}>
            {paperSectors(outer.parts, R.outer[0], R.outer[1], art.tabs)}
            <path className="pp-grid" d={outer.grid} />
            <path className="pp-edge" d={outlines.outer} />
          </g>
        </g>

        {/* Mineral band: watercolor tone with soft mottling. */}
        <g className="pp-layer pp-depth-3">
          <g className="pp-shadow-offset">
            <g className="pp-spin" style={spin(art.offsets.mineral, 50)}>
              <path className="pp-shadow" d={outlines.mineral} />
            </g>
          </g>
          <g className="pp-spin" style={spin(art.offsets.mineral, 50)}>
            {mineral.parts.map(([a0, a1], i) => (
              <path key={i} d={sector(R.mineral[0], R.mineral[1], a0, a1)} fill={`url(#${id("mineral")})`} />
            ))}
            <g clipPath={`url(#${id("mineralClip")})`}>
              <circle cx="62" cy="80" r="16" fill={`url(#${id("mottle")})`} />
              <circle cx="138" cy="128" r="20" fill={`url(#${id("mottle")})`} />
              <circle cx="120" cy="52" r="12" fill={`url(#${id("mottle")})`} />
              <circle cx="70" cy="140" r="14" fill={`url(#${id("mottle")})`} />
            </g>
            <path className="pp-grid pp-grid-mineral" d={mineral.grid} />
            <path className="pp-edge" d={outlines.mineral} />
          </g>
        </g>

        {/* Inner grid-paper ring. */}
        <g className="pp-layer pp-depth-2">
          <g className="pp-shadow-offset">
            <g className="pp-spin" style={spin(art.offsets.inner, 0)}>
              <path className="pp-shadow" d={outlines.inner} />
            </g>
          </g>
          <g className="pp-spin" style={spin(art.offsets.inner, 0)}>
            {paperSectors(inner.parts, R.inner[0], R.inner[1])}
            <path className="pp-grid" d={inner.grid} />
            <path className="pp-edge" d={outlines.inner} />
          </g>
        </g>

        {/* Reading beam: runs out of the core through the aligned gaps. */}
        <g className="pp-layer pp-depth-2">
          <g className="pp-beam-axis">
            <g className="pp-beam">
              <path d="M100 98.4L190 95.2V104.8L100 101.6Z" fill={`url(#${id("beam")})`} />
              <path className="pp-beam-line" d="M122 100H168" />
            </g>
          </g>
        </g>

        {/* Recessed cobalt core in its paper bezel. */}
        <g className="pp-layer pp-depth-core">
          <circle cx={C} cy={C} r="44" fill={`url(#${id("halo")})`} className="pp-halo" />
          <circle cx={C} cy={C} r={R.bezel} fill={`url(#${id("bezel")})`} className="pp-bezel" />
          <path className="pp-bezel-light" d={arc(24.2, 196, 292)} />
          <g className="pp-core">
            <circle cx={C} cy={C} r={R.core} fill={`url(#${id("glass")})`} />
            <g clipPath={`url(#${id("glassClip")})`}>
              <rect x="70" y="70" width="60" height="60" fill={`url(#${id("streak")})`} className="pp-streak" />
              <path className="pp-orbits" d={LENS} />
              {STARS.map(([x, y, o], i) => (
                <circle key={i} cx={C + x} cy={C + y} r={o} className="pp-star" />
              ))}
            </g>
            <circle cx={C} cy={C} r={R.core - 0.6} className="pp-recess" />
            <g className="pp-spec">
              <path d={arc(18.6, 4, 116)} className="pp-crescent-glow" />
              <path
                d={`M${polar(20, 14)}A20 20 0 0 1 ${polar(20, 106)}A34 34 0 0 0 ${polar(20, 14)}Z`}
                className="pp-crescent"
              />
              <circle cx={C + 19 * Math.cos(0.96)} cy={C + 19 * Math.sin(0.96)} r="1.3" className="pp-glint" />
              <path
                className="pp-flare"
                d={`M${C + 19 * Math.cos(0.96) - 4} ${C + 19 * Math.sin(0.96)}h8M${C + 19 * Math.cos(0.96)} ${C + 19 * Math.sin(0.96) - 4}v8`}
              />
            </g>
          </g>
        </g>

        {/* Selection: flecks gather into the core, then a shockwave leaves it. */}
        {burst > 0 ? (
          <g key={burst} className="pp-burst">
            {FLECKS.map((a, i) => (
              <rect
                key={a}
                x="-3.6"
                y="-2.2"
                width="7.2"
                height="4.4"
                rx="0.6"
                className={cn(
                  "pp-fleck",
                  i % 4 === 1 && "pp-fleck-coral",
                  i % 4 === 3 && "pp-fleck-green",
                  i % 6 === 4 && "pp-fleck-cobalt"
                )}
                style={{ "--a": `${a}deg`, "--i": i, "--r0": `${84 + (i % 3) * 9}px` } as CSSProperties}
              />
            ))}
            <circle cx={C} cy={C} r="30" className="pp-flash" fill={`url(#${id("flash")})`} />
            <circle cx={C} cy={C} r="24" className="pp-wave" />
            <circle cx={C} cy={C} r="24" className="pp-wave pp-wave-late" />
          </g>
        ) : null}
      </svg>
      <span className="auth-demo-role-name">{account.label}</span>
    </button>
  );
});

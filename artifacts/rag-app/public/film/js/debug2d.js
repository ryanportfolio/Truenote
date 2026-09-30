// Canvas 2D stand-in for render.js: projected, depth-sorted, flat-lit tiles.
// Only for checking choreography (?debug2d); the film ships with render.js.
import { cameraMatrices, project } from './camera.js';

export function createDebugRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  let W = canvas.width, H = canvas.height;
  let order = new Uint32Array(0), depth = new Float32Array(0);
  return {
    gl: null,
    resize(w, h) { canvas.width = W = w; canvas.height = H = h; },
    destroy() {},
    render(fs) {
      const s = W / 1920;
      const ink = fs.ground.ink;
      const mix = (a, b) => Math.round(a + (b - a) * ink);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = `rgb(${mix(232, 11)},${mix(230, 16)},${mix(222, 32)})`;
      ctx.fillRect(0, 0, W, H);
      ctx.setTransform(s, 0, 0, s, 0, 0);
      const { viewProj } = cameraMatrices(fs.cam);
      const m = viewProj;
      const proj = (x, y, z) => {
        const w = m[3] * x + m[7] * y + m[11] * z + m[15];
        return [((m[0] * x + m[4] * y + m[8] * z + m[12]) / w * 0.5 + 0.5) * 1920, (1 - ((m[1] * x + m[5] * y + m[9] * z + m[13]) / w * 0.5 + 0.5)) * 1080, w];
      };
      if (fs.core.on > 0) {
        const c = project(fs.cam, fs.core.x, fs.core.y, 0);
        ctx.fillStyle = `rgba(0,64,171,${fs.core.on * (1 - 0.5 * fs.core.dim)})`;
        ctx.beginPath(); ctx.arc(c.sx, c.sy, fs.core.r * c.scale, 0, Math.PI * 2); ctx.fill();
      }
      for (const wv of fs.waves) {
        const c = project(fs.cam, wv.x, wv.y, 0);
        ctx.strokeStyle = wv.hue > 0.5 ? `rgba(245,159,10,${wv.intensity})` : `rgba(40,110,255,${wv.intensity})`;
        ctx.lineWidth = Math.max(1, wv.width * c.scale * 0.3);
        ctx.beginPath(); ctx.arc(c.sx, c.sy, wv.r * c.scale, 0, Math.PI * 2); ctx.stroke();
      }
      const T = fs.tiles, n = fs.count;
      if (order.length !== n) { order = new Uint32Array(n); depth = new Float32Array(n); }
      for (let i = 0; i < n; i++) {
        order[i] = i;
        const k = i * 16;
        depth[i] = m[3] * T[k] + m[7] * T[k + 1] + m[11] * T[k + 2] + m[15];
      }
      order.sort((a, b) => depth[b] - depth[a]);
      const L = [Math.cos(fs.light.az) * Math.cos(fs.light.el), Math.sin(fs.light.az) * Math.cos(fs.light.el), Math.sin(fs.light.el)];
      for (let oi = 0; oi < n; oi++) {
        const i = order[oi], k = i * 16;
        if (T[k + 11] <= 0.01) continue;
        const [x, y, z, rx, ry, rz, w, h] = [T[k], T[k + 1], T[k + 2], T[k + 3], T[k + 4], T[k + 5], T[k + 6], T[k + 7]];
        const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
        // M = Rz * Ry * Rx applied to local (u, v, 0).
        const rot = (u, v) => {
          let px = u, py = v * cx, pz = v * sx;
          const qx = px * cy + pz * sy, qz = -px * sy + pz * cy;
          px = qx; pz = qz;
          return [px * cz - py * sz, px * sz + py * cz, pz];
        };
        const nrm = (() => { const a = rot(1, 0), b = rot(0, 1); return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; })();
        const lam = 0.45 + 0.55 * Math.abs(nrm[0] * L[0] + nrm[1] * L[1] + nrm[2] * L[2]);
        const pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([u, v]) => { const r = rot(u, v); return proj(x + r[0], y + r[1], z + r[2]); });
        if (pts.some((p) => p[2] <= 1)) continue;
        const g = T[k + 13], hue = T[k + 14];
        const gr = g * (1 - hue) * 0 + g * hue * 245, gg = g * hue * 159 + g * (1 - hue) * 64, gb = g * (1 - hue) * 171;
        const R = Math.min(255, T[k + 8] * 255 * lam * (1 - g * 0.5) + gr), G = Math.min(255, T[k + 9] * 255 * lam * (1 - g * 0.5) + gg), B = Math.min(255, T[k + 10] * 255 * lam * (1 - g * 0.5) + gb);
        ctx.globalAlpha = T[k + 11];
        ctx.fillStyle = `rgb(${R | 0},${G | 0},${B | 0})`;
        ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
        for (let q = 1; q < 4; q++) ctx.lineTo(pts[q][0], pts[q][1]);
        ctx.closePath(); ctx.fill();
      }
      ctx.globalAlpha = 1;
      for (const b of fs.beams) {
        const p0 = proj(b.x0, b.y0, b.z0), p1 = proj(b.x1, b.y1, b.z1);
        ctx.strokeStyle = b.hue > 0.5 ? `rgba(245,159,10,${b.intensity})` : `rgba(40,110,255,${b.intensity})`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke();
      }
      if (fs.post.fade > 0) { ctx.fillStyle = `rgba(11,16,32,${fs.post.fade})`; ctx.fillRect(0, 0, 1920, 1080); }
    },
  };
}

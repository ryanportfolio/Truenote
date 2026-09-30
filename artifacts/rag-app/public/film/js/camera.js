// Shared camera math for the renderer and the 2D UI layer.
// World: x right, y down, z up off the table, in 1920x1080 design pixels.
// That frame is mirrored relative to GL's right-handed y-up space, so the view
// matrix folds in F = diag(1, -1, 1). det(F) = -1 flips triangle winding:
// renderers must not rely on face culling.

export const DESIGN_W = 1920;
export const DESIGN_H = 1080;
export const DEFAULT_FOV = 30;

export function defaultCam(fov = DEFAULT_FOV) {
  const d = (DESIGN_H / 2) / Math.tan((fov * Math.PI) / 360);
  return { x: 960, y: 540, z: d, tx: 960, ty: 540, tz: 0, ux: 0, uy: -1, uz: 0, fov };
}

function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function mul4(a, b, out = new Float32Array(16)) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

export function cameraMatrices(cam, aspect = DESIGN_W / DESIGN_H, near = 20, far = 20000) {
  // Mirror world into GL space (negate y), then a standard lookAt.
  const eye = [cam.x, -cam.y, cam.z];
  const tgt = [cam.tx, -cam.ty, cam.tz];
  const up = [cam.ux, -cam.uy, cam.uz];
  const f = normalize([tgt[0] - eye[0], tgt[1] - eye[1], tgt[2] - eye[2]]);
  const s = normalize(cross(f, up));
  const u = cross(s, f);
  const look = new Float32Array([
    s[0], u[0], -f[0], 0,
    s[1], u[1], -f[1], 0,
    s[2], u[2], -f[2], 0,
    -dot(s, eye), -dot(u, eye), dot(f, eye), 1,
  ]);
  const flip = new Float32Array([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const view = mul4(look, flip);
  const fy = 1 / Math.tan((cam.fov * Math.PI) / 360);
  const proj = new Float32Array([
    fy / aspect, 0, 0, 0,
    0, fy, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ]);
  return { view, proj, viewProj: mul4(proj, view), eye: [cam.x, cam.y, cam.z] };
}

// World point -> design-frame pixel. scale = design px per world unit at that depth.
export function project(cam, x, y, z, aspect = DESIGN_W / DESIGN_H) {
  const { view, viewProj } = cameraMatrices(cam, aspect);
  const cx = viewProj[0] * x + viewProj[4] * y + viewProj[8] * z + viewProj[12];
  const cy = viewProj[1] * x + viewProj[5] * y + viewProj[9] * z + viewProj[13];
  const cw = viewProj[3] * x + viewProj[7] * y + viewProj[11] * z + viewProj[15];
  const vz = view[2] * x + view[6] * y + view[10] * z + view[14];
  const depth = -vz;
  const w = cw || 1e-6;
  const scale = DESIGN_H / (2 * depth * Math.tan((cam.fov * Math.PI) / 360));
  return {
    sx: (cx / w * 0.5 + 0.5) * DESIGN_W,
    sy: (1 - (cy / w * 0.5 + 0.5)) * DESIGN_H,
    depth,
    scale,
  };
}

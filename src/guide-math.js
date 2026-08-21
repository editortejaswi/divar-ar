// Pure guidance math — no three.js / DOM deps, so it is unit-testable in Node.

// Signed relative angle in degrees from where the phone points to a target.
// `yaw`   = camera yaw in radians (THREE Euler 'YXZ' .y, pitch-independent).
// `px,pz` = world-space XZ direction from the user to the target.
// Result: 0 = straight ahead, + = target is to the RIGHT, - = to the LEFT, ±180 = behind.
export function relAngle(yaw, px, pz) {
  const hx = -Math.sin(yaw), hz = -Math.cos(yaw);          // camera heading (horizontal)
  return Math.atan2(hx * pz - hz * px, hx * px + hz * pz) * 180 / Math.PI;
}

// Map a relative angle to a spoken cue, with hysteresis around the "straight" band
// (`prev` = last spoken cue) so compass jitter near a boundary can't flip the cue.
export function cueFor(ang, prev) {
  const a = Math.abs(ang);
  if (a > 150) return 'around';
  const straightIn = prev === 'straight' ? 32 : 18;        // must exceed 32° to leave "straight"
  if (a < straightIn) return 'straight';
  return ang > 0 ? 'right' : 'left';
}

// ---- road-following geometry (XZ polylines of {x,z} world points) ----

// Nearest point on a polyline to (px,pz) -> { seg, t, dist }.
export function nearestOnPoly(px, pz, poly) {
  let best = { d2: Infinity, seg: 0, t: 0 };
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i], b = poly[i + 1], dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz || 1e-9;
    let t = ((px - a.x) * dx + (pz - a.z) * dz) / len2; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const x = a.x + dx * t, z = a.z + dz * t, dd = (px - x) ** 2 + (pz - z) ** 2;
    if (dd < best.d2) best = { d2: dd, seg: i, t };
  }
  best.dist = Math.sqrt(best.d2); return best;
}

// Point + unit forward direction at arc-length `s` past (seg,t), walking toward the
// polyline end. Sets `end:true` once `s` runs past the final vertex.
export function alongPoly(poly, seg, t, s) {
  if (!poly || poly.length < 2) return { x: poly?.[0]?.x ?? 0, z: poly?.[0]?.z ?? 0, dx: 0, dz: 0, end: true };
  let i = seg, cx = poly[i].x + (poly[i + 1].x - poly[i].x) * t, cz = poly[i].z + (poly[i + 1].z - poly[i].z) * t;
  while (i < poly.length - 1) {
    const b = poly[i + 1], dx = b.x - cx, dz = b.z - cz, sl = Math.hypot(dx, dz);
    if (s <= sl) { const f = sl ? s / sl : 0; return { x: cx + dx * f, z: cz + dz * f, dx: dx / (sl || 1), dz: dz / (sl || 1) }; }
    s -= sl; cx = b.x; cz = b.z; i++;
  }
  const j = Math.max(0, poly.length - 2), dx = poly[j + 1].x - poly[j].x, dz = poly[j + 1].z - poly[j].z, L = Math.hypot(dx, dz) || 1;
  return { x: poly[poly.length - 1].x, z: poly[poly.length - 1].z, dx: dx / L, dz: dz / L, end: true };
}

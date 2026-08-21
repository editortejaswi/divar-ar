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

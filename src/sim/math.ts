/**
 * Tiny 2D vector math for the headless simulation.
 *
 * Gameplay lives entirely on the XZ plane (Y is a presentation-only terrain
 * height added by the render layer), so the sim never needs a 3-component
 * vector. These are plain `{ x, z }` records plus free functions — no classes,
 * no `three`, so this module runs unchanged in a Worker.
 */
export interface Vec2 {
  x: number;
  z: number;
}

export function vec2(x = 0, z = 0): Vec2 {
  return { x, z };
}

export function clone(v: Vec2): Vec2 {
  return { x: v.x, z: v.z };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, z: a.z + b.z };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, z: a.z - b.z };
}

export function scale(v: Vec2, s: number): Vec2 {
  return { x: v.x * s, z: v.z * s };
}

export function length(v: Vec2): number {
  return Math.hypot(v.x, v.z);
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function distanceSq(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

/** Unit vector in the direction of `v`; returns `{0,0}` for a zero vector. */
export function normalize(v: Vec2): Vec2 {
  const len = length(v);
  if (len < 1e-9) return { x: 0, z: 0 };
  return { x: v.x / len, z: v.z / len };
}

/** Yaw angle used for facing/orientation, matching the render layer's convention. */
export function heading(dir: Vec2): number {
  return Math.atan2(dir.x, dir.z);
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

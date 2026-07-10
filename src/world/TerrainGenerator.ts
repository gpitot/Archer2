/**
 * Generates interesting arena terrain using combined mathematical functions.
 *
 * Features:
 * - Rolling hills throughout the arena
 * - A central elevated ridge
 * - Two plateaus (north-east and south-west)
 * - A basin/depression
 * - Steep boundary cliffs
 */

/**
 * Smooth step function (cubic Hermite).
 */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * 2D Gaussian bump.
 */
function gaussian(x: number, z: number, cx: number, cz: number, sx: number, sz: number, amplitude: number): number {
  const dx = (x - cx) / sx;
  const dz = (z - cz) / sz;
  return amplitude * Math.exp(-0.5 * (dx * dx + dz * dz));
}

/**
 * Creates a ridge line between two points.
 */
function ridge(x: number, z: number, x1: number, z1: number, x2: number, z2: number, width: number, amplitude: number): number {
  // Project point onto ridge line segment
  const dx = x2 - x1;
  const dz = z2 - z1;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len === 0) return 0;

  const ux = dx / len;
  const uz = dz / len;

  const px = x - x1;
  const pz = z - z1;
  const t = Math.max(0, Math.min(1, (px * ux + pz * uz) / len));

  // Distance from point to line
  const projX = x1 + t * dx;
  const projZ = z1 + t * dz;
  const dist = Math.sqrt((x - projX) ** 2 + (z - projZ) ** 2);

  // Falloff based on distance from ridge center
  const falloff = Math.exp(-0.5 * (dist / width) ** 2);

  // Ridge profile: highest in center, tapering at ends
  const endTaper = 1 - Math.abs(t - 0.5) * 2; // 1 at center, 0 at ends
  const taper = 0.3 + 0.7 * endTaper;

  return amplitude * falloff * taper;
}

/**
 * Generate the arena terrain height at world position (wx, wz).
 */
export function generateTerrainHeight(wx: number, wz: number): number {
  // Arena bounds: ±100 in XZ
  const halfArena = 100;
  const edgeDist = halfArena - Math.max(Math.abs(wx), Math.abs(wz));

  // ── Base rolling hills ──
  let h = 0;
  h += Math.sin(wx * 0.03) * Math.cos(wz * 0.04) * 1.5;
  h += Math.sin(wx * 0.07 + 1.5) * Math.cos(wz * 0.06 + 2.0) * 0.8;
  h += Math.cos(wx * 0.05) * Math.sin(wz * 0.05) * 0.6;

  // ── Central ridge (NW-SE) ──
  h += ridge(wx, wz, -60, -60, 60, 60, 8, 4.0);

  // ── Two plateaus ──
  h += gaussian(wx, wz, 50, 45, 20, 18, 5.0);  // NE plateau
  h += gaussian(wx, wz, -55, -50, 22, 20, 4.5); // SW plateau

  // ── Additional hills ──
  h += gaussian(wx, wz, -30, 30, 25, 22, 2.5);
  h += gaussian(wx, wz, 35, -40, 20, 25, 2.0);
  h += gaussian(wx, wz, -70, 10, 18, 15, 1.8);
  h += gaussian(wx, wz, 20, 65, 15, 20, 2.2);

  // ── Basin / depression ──
  h -= gaussian(wx, wz, -10, -15, 15, 12, 2.0);

  // ── Edge cliffs (steep rise at boundaries) ──
  // Inner 80% is playable, outer 20% ramps up sharply
  if (edgeDist < 15) {
    const t = 1 - smoothstep(0, 15, edgeDist);
    h += t * 6.0; // steep 6-unit cliff
  }

  // Clamp to reasonable range
  return Math.max(-2, Math.min(10, h));
}


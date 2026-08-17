/**
 * Graphics quality tiers.
 *
 * The renderer is a forward-rendered Three.js scene: every extra fragment and
 * every extra per-fragment light multiplies across a screen that is mostly
 * terrain. Weak machines therefore need fewer fragments (pixel ratio, render
 * scale), cheaper shading (Lambert terrain, no MSAA), and fewer particles —
 * not fewer objects. This module is the single place those dials live so no
 * consumer has to guess what "low" means.
 *
 * Resolution order, highest priority first:
 *   1. `?quality=high|low` in the URL (never persisted — a one-off override)
 *   2. the saved `archer-quality` pref (manual toggle, or an adaptive demotion)
 *   3. auto-detect from CPU core count and the WebGL renderer string
 *
 * Everything here is read once at startup: `antialias` in particular is fixed
 * at renderer-creation time, so a tier change only fully applies after reload.
 */
import { loadPref, savePref } from './playerPrefs';

export type QualityTier = 'high' | 'low';

export interface QualityConfig {
  tier: QualityTier;
  /** Upper bound on `devicePixelRatio` handed to the renderer. */
  pixelRatioCap: number;
  /** MSAA. Renderer-creation-time only — changing it needs a reload. */
  antialias: boolean;
  /** Fog render-texture upsample factor over the coarse vision grid. */
  fogUpsample: number;
  /** Gaussian blur radius applied to the upsampled fog field, in hi texels. */
  fogBlurRadius: number;
  /** Multiplier on particle counts and effect sizes (1 = authored density). */
  effectsDensity: number;
  /**
   * Whether *static* point lights (fountains) are added to the scene. Dynamic
   * lights are gone on both tiers — see `src/rendering/Lighting.ts`.
   */
  staticLights: boolean;
  /** HUD rebuild rate, Hz. */
  hudHz: number;
  /** Minimap redraw rate, Hz. */
  minimapHz: number;
  /** Shade terrain with MeshLambertMaterial instead of MeshStandardMaterial. */
  terrainLambert: boolean;
  /** Let `AdaptiveResolution` scale the render target under load. */
  adaptiveResolution: boolean;
  /** Lowest render scale the adaptive controller may step down to. */
  renderScaleFloor: number;
}

const QUALITY_KEY = 'archer-quality';

const HIGH: QualityConfig = {
  tier: 'high',
  pixelRatioCap: 2,
  antialias: true,
  fogUpsample: 4,
  fogBlurRadius: 2,
  effectsDensity: 1,
  staticLights: true,
  hudHz: 15,
  minimapHz: 15,
  terrainLambert: false,
  adaptiveResolution: true,
  renderScaleFloor: 0.75,
};

const LOW: QualityConfig = {
  tier: 'low',
  pixelRatioCap: 1,
  antialias: false,
  fogUpsample: 2,
  fogBlurRadius: 1,
  // Roughly a third of the authored particle counts (arrow trails go 34 → 12).
  // Sizes are scaled more gently — see `effectScale`.
  effectsDensity: 0.35,
  staticLights: false,
  hudHz: 10,
  minimapHz: 10,
  terrainLambert: true,
  adaptiveResolution: true,
  renderScaleFloor: 0.5,
};

const TIERS: Record<QualityTier, QualityConfig> = { high: HIGH, low: LOW };

function parseTier(raw: string | null): QualityTier | null {
  return raw === 'high' || raw === 'low' ? raw : null;
}

/**
 * GPUs and software rasterizers that are reliably too slow for the default
 * tier: integrated Intel parts, mobile GPU families, and the two software
 * fallbacks Chromium uses when hardware acceleration is unavailable.
 */
const SLOW_GPU_RE = /(Intel|SwiftShader|llvmpipe|Mali|Adreno|PowerVR)/i;

/** Best-effort GPU name via WEBGL_debug_renderer_info; '' when unavailable. */
function gpuName(): string {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return '';
    const ext = (gl as WebGLRenderingContext).getExtension('WEBGL_debug_renderer_info');
    if (!ext) return '';
    return String((gl as WebGLRenderingContext).getParameter(
      (ext as { UNMASKED_RENDERER_WEBGL: number }).UNMASKED_RENDERER_WEBGL,
    ));
  } catch {
    return '';
  }
}

function autoDetectTier(): QualityTier {
  const cores = navigator.hardwareConcurrency ?? 8;
  if (cores <= 4) return 'low';
  if (SLOW_GPU_RE.test(gpuName())) return 'low';
  return 'high';
}

let _config: QualityConfig | null = null;
/** True when the active tier came from `?quality=`, which must not be saved. */
let _fromUrl = false;

/**
 * The active quality config. Resolved on first call and cached — call sites
 * can read it freely in hot paths.
 */
export function quality(): QualityConfig {
  if (_config) return _config;

  let tier: QualityTier | null = null;
  try {
    tier = parseTier(new URLSearchParams(window.location.search).get('quality'));
  } catch { /* no DOM (tests) — fall through to the pref */ }
  if (tier) _fromUrl = true;

  if (!tier) tier = parseTier(loadPref(QUALITY_KEY));
  if (!tier) tier = autoDetectTier();

  _config = TIERS[tier];
  return _config;
}

/**
 * Multiplier for effect *sizes* (flash radii, ring diameters), as opposed to
 * particle counts. Halving a radius quarters the fragments it covers, so sizes
 * only need a gentle trim where counts take a big cut.
 */
export function effectScale(): number {
  return 0.5 + 0.5 * quality().effectsDensity;
}

/** The tier resolution would pick right now, without consulting `quality()`. */
export function detectedTier(): QualityTier {
  return autoDetectTier();
}

/**
 * Persist a tier choice. Takes effect for shader-level settings (MSAA, terrain
 * material) on the next reload; the in-memory config is updated immediately so
 * anything that re-reads it picks the new dials up right away.
 */
export function setQualityTier(tier: QualityTier): void {
  savePref(QUALITY_KEY, tier);
  // A `?quality=` override stays in force for this session so the URL keeps
  // meaning what it says; the pref is still written for the next load.
  if (!_fromUrl) _config = TIERS[tier];
}

/** The saved tier, or null when the player has never chosen one. */
export function savedQualityTier(): QualityTier | null {
  return parseTier(loadPref(QUALITY_KEY));
}

/** Forget an explicit choice and go back to auto-detection on the next load. */
export function clearQualityTier(): void {
  savePref(QUALITY_KEY, 'auto'); // any non-tier value re-enables auto-detect
  if (!_fromUrl) _config = TIERS[autoDetectTier()];
}

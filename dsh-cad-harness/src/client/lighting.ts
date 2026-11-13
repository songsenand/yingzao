// Viewport lighting: one camera-relative studio rig for every 3D surface.
//
// WHY THIS EXISTS. Both viewports used to run `AmbientLight(0.6)` plus a single
// `DirectionalLight(1.2)` fixed at world (30,50,20). Two things follow from
// that, and both read to a human as "细节看不清":
//
//   1. The key was WORLD-fixed. Orbiting to inspect the far side of a boss put
//      the visible face in shadow, with only the ambient flood left on it — the
//      shape you were looking at was the shape that was not lit.
//   2. Ambient contributed a third of the flat light (0.6 of 1.8). Shading is
//      what carries small features — a rib, a fillet, the inside of a pocket —
//      and a large constant term compresses exactly that signal, so everything
//      collapsed toward one tone.
//
// The rig below is the standard fix: three directional lights hung off the
// CAMERA (key up-left-front, fill opposite, rim from behind), so the visible
// side is always keyed and orbiting keeps the shading informative; plus a low
// hemisphere term for readability of unlit faces and a bright rim to separate
// the silhouette from the near-white background.
//
// Light and target both ride the rig, so each direction is fixed in VIEW space
// and does not depend on where the model sits in world space (the viewport
// frames parts wherever they were authored).

import * as THREE from 'three';
import { t as tr } from './i18n.ts';

/** The rig, exposed for tuning and for the structural acceptance test. */
export interface StudioLights {
  rig: THREE.Group;
  key: THREE.DirectionalLight;
  fill: THREE.DirectionalLight;
  rim: THREE.DirectionalLight;
  ambient: THREE.HemisphereLight;
}

/** Key/fill/rim intensities, in the order they are created. */
export const STUDIO_LIGHT_LEVELS = { key: 2.4, fill: 0.5, rim: 0.85, ambient: 0.24 } as const;

/**
 * Colour pipeline for these viewports.
 *
 * A key this strong clips a straight-lit face to flat white, and a clipped face
 * carries no shading at all — which is the thing we are trying to keep. Filmic
 * tone mapping rolls the highlight off instead, so the bright side keeps its
 * gradient. (The background is a clear colour, so it is not tone-mapped: the
 * part gains contrast against it rather than sharing its compression.)
 *
 * @param renderer - the viewport's renderer.
 */
export function configureStudioRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
}

/**
 * Hang the studio rig on a camera and add a little ambient to the scene.
 *
 * @param scene - the scene being rendered (receives the ambient; also receives
 *   the camera when it has no parent yet, so camera children are traversed).
 * @param camera - the orbiting camera; the rig moves with it.
 * @returns the rig, for tests and for live tweaking.
 */
export function attachStudioLights(scene: THREE.Scene, camera: THREE.Camera): StudioLights {
  const rig = new THREE.Group();
  rig.name = 'studio-lights';

  const directional = (
    intensity: number,
    position: [number, number, number],
    name: string,
  ): THREE.DirectionalLight => {
    const light = new THREE.DirectionalLight(0xffffff, intensity);
    light.name = name;
    light.position.set(...position);
    // The target must be in the graph for its world matrix to update; keeping it
    // inside the rig is what makes the direction view-relative.
    rig.add(light, light.target);
    return light;
  };

  const key = directional(STUDIO_LIGHT_LEVELS.key, [-1.15, 1.5, 2.0], 'key');
  const fill = directional(STUDIO_LIGHT_LEVELS.fill, [2.0, 0.45, 1.15], 'fill');
  const rim = directional(STUDIO_LIGHT_LEVELS.rim, [0.2, -0.9, -2.0], 'rim');

  camera.add(rig);
  if (!camera.parent) scene.add(camera);

  // Sky slightly brighter than ground: a vertical gradient reads as "up" and
  // keeps faces the key misses legible without flattening them.
  const ambient = new THREE.HemisphereLight(0xffffff, 0x8c98a6, STUDIO_LIGHT_LEVELS.ambient);
  ambient.name = 'ambient';
  scene.add(ambient);

  return { rig, key, fill, rim, ambient };
}

// ---------------------------------------------------------------- backgrounds
//
// The ground the model sits on is part of "can I see it", not decoration. The
// part is a light blue (#7aa7d9 with the studio rig on it), so these presets
// span VALUE rather than hue: a pale ground for drawings and screenshots, a warm
// one that flatters the cool part, and two dark ones where a lit part gains the
// most separation. Mid-greys were left out on purpose — they sit closest to the
// part's own value, which is exactly the contrast problem being fixed.

/** One selectable viewport ground. */
export interface ViewportBackground {
  id: string;
  label: string;
  /** The scene clear colour. */
  hex: string;
  /** Ink for the DOM overlays drawn on top of it (triad, scale bar). */
  ink: 'dark' | 'light';
}

export const VIEWPORT_BACKGROUNDS: readonly ViewportBackground[] = [
  { id: 'paper', label: tr('ui.bg.paper'), hex: '#f2f3f5', ink: 'dark' },
  { id: 'warm', label: tr('ui.bg.warm'), hex: '#e6e0d6', ink: 'dark' },
  { id: 'graphite', label: tr('ui.bg.graphite'), hex: '#39424d', ink: 'light' },
  { id: 'midnight', label: tr('ui.bg.midnight'), hex: '#1c2733', ink: 'light' },
];

export const DEFAULT_BACKGROUND_ID = 'paper';
/** localStorage key for the choice; the panel persists it like `cad.bodyH`. */
export const BACKGROUND_STORAGE_KEY = 'cad.viewportBg';

/** Look one preset up by id, falling back to the default (never throws). */
export function backgroundById(id: string | null | undefined): ViewportBackground {
  return VIEWPORT_BACKGROUNDS.find((b) => b.id === id)
    ?? VIEWPORT_BACKGROUNDS.find((b) => b.id === DEFAULT_BACKGROUND_ID)
    ?? VIEWPORT_BACKGROUNDS[0]!;
}

/** Read the remembered choice; an unknown or unreadable value falls back. */
export function loadBackgroundId(): string {
  try {
    const raw = localStorage.getItem(BACKGROUND_STORAGE_KEY);
    return raw && VIEWPORT_BACKGROUNDS.some((b) => b.id === raw) ? raw : DEFAULT_BACKGROUND_ID;
  } catch {
    return DEFAULT_BACKGROUND_ID;
  }
}

/** Remember the choice; storage being unavailable must not break the panel. */
export function saveBackgroundId(id: string): void {
  try { localStorage.setItem(BACKGROUND_STORAGE_KEY, id); } catch { /* private mode, say */ }
}

/**
 * Overlay ink for one ground.
 *
 * The scale bar and the readout are DOM, drawn over the canvas: on a dark ground
 * the old fixed `#26303a` ink disappears. The halo is the opposite end, so the
 * text stays legible wherever it lands on the model.
 */
export function overlayInk(bg: ViewportBackground): { color: string; halo: string } {
  return bg.ink === 'light'
    ? { color: '#eef1f4', halo: '#1c2733' }
    : { color: '#26303a', halo: '#f2f3f5' };
}

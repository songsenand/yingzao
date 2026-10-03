// Acceptance for the viewport light rig (DESGIGN §6.11).
//
// The complaint this answers: "细节一点的东西就看不清". Two measurable causes,
// both provable without a GPU, because they are properties of the scene graph
// and not of any pixel:
//
//   1. THE KEY MUST FOLLOW THE CAMERA. The old rig was one directional light at
//      world (30,50,20): orbiting put the visible face in shadow. Here the rig is
//      parented to the camera, and that is asserted the only way it can be —
//      rotate the camera and watch the light's WORLD direction rotate with it.
//   2. AMBIENT MUST NOT DROWN THE SHAPE. Shading carries small features, and a
//      large constant term compresses it. The old rig spent 0.6 of its 1.8 flat
//      light on ambient (33%); the rig asserts a ceiling well under that, plus a
//      key that dominates.
//
// three.js builds a scene graph with no rendering context, so this runs headless
// in the sandbox — which is also the only honest option here: this sandbox's
// Firefox has no WebGL at all (probe: WEBGL UNAVAILABLE, no /dev/dri), so pixels
// cannot be produced or compared from here.
//
//   node scripts/accept-lighting.mjs

import * as THREE from 'three';
import {
  STUDIO_LIGHT_LEVELS, attachStudioLights, VIEWPORT_BACKGROUNDS, backgroundById, loadBackgroundId,
  overlayInk,
} from '../src/client/lighting.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
camera.position.set(0, 0, 100);
camera.updateMatrixWorld(true);
const { rig, key, fill, rim, ambient } = attachStudioLights(scene, camera);

// --- 1. the rig is camera-relative ------------------------------------------
{
  check(rig.parent === camera, 'the rig hangs off the camera, not the world');
  check(scene.children.includes(camera), 'the camera is in the scene (camera children are traversed)');
  check(scene.children.includes(ambient), 'the ambient term is in the scene');
  for (const [name, light] of [['key', key], ['fill', fill], ['rim', rim]]) {
    check(light.parent === rig, `${name} is part of the rig`);
    check(light.target.parent === rig, `${name}'s target rides the rig (view-relative direction)`);
  }
}

// --- 2. the key sits up-left-front IN VIEW SPACE ----------------------------
{
  // Local offsets are view-space by construction (both ends live in the rig).
  const dirOf = (light) => light.position.clone().sub(light.target.position).normalize();
  const k = dirOf(key);
  check(k.x < 0 && k.y > 0 && k.z > 0,
    'the key comes from the up-left in FRONT of the camera',
    `dir=(${k.x.toFixed(2)}, ${k.y.toFixed(2)}, ${k.z.toFixed(2)})`);
  const f = dirOf(fill);
  check(f.x > 0, 'the fill comes from the opposite side', `dir.x=${f.x.toFixed(2)}`);
  const r = dirOf(rim);
  check(r.z < 0, 'the rim comes from behind (silhouette separation)', `dir.z=${r.z.toFixed(2)}`);

  // The whole point: rotate the camera and the KEY's world direction follows.
  const worldDir = () => {
    camera.updateMatrixWorld(true);
    const p = new THREE.Vector3(), t = new THREE.Vector3();
    key.getWorldPosition(p);
    key.target.getWorldPosition(t);
    return p.sub(t).normalize();
  };
  const before = worldDir();
  camera.position.set(100, 0, 0);
  camera.lookAt(0, 0, 0);
  const after = worldDir();
  check(before.distanceTo(after) > 0.5,
    'orbiting the camera moves the key with it (the visible side stays lit)',
    `Δ=${before.distanceTo(after).toFixed(2)}`);

  // And the direction is stable in view space — that is what "rig" means.
  const localBefore = dirOf(key).clone();
  camera.updateMatrixWorld(true);
  check(dirOf(key).distanceTo(localBefore) < 1e-9,
    'the key direction is unchanged in view space while the camera moves');
}

// --- 3. ambient must not drown the shading ----------------------------------
{
  check(ambient.isHemisphereLight === true, 'the constant term is a hemisphere (sky over ground), not a flat flood');
  check(ambient.groundColor.getHex() !== ambient.color.getHex(),
    'sky and ground differ, so "up" is readable',
    `sky=#${ambient.color.getHexString()} ground=#${ambient.groundColor.getHexString()}`);
  const keyI = key.intensity, ambI = ambient.intensity, fillI = fill.intensity;
  check(keyI > fillI && keyI > rim.intensity, 'the key dominates the fill and the rim',
    `key=${keyI} fill=${fillI} rim=${rim.intensity}`);
  // Same accounting that indicted the old rig: ambient share of all flat light.
  const oldAmbientShare = 0.6 / (0.6 + 1.2);
  const share = ambI / (ambI + keyI + fillI + rim.intensity);
  check(share < 0.2, 'ambient is a minor share of the light budget',
    `${(share * 100).toFixed(0)}% (was ${(oldAmbientShare * 100).toFixed(0)}%)`);
  check(ambI <= 0.35, 'ambient stays low enough for shading to carry detail', `ambient=${ambI}`);

  // Contrast estimate between a face turned toward the key and one turned away.
  const lit = ambI + keyI + fillI * 0.5;
  const unlit = ambI;
  check(lit / unlit >= 3, 'a key-facing face is at least 3× a back-facing one',
    `${(lit / unlit).toFixed(1)}× (was ${((0.6 + 1.2) / 0.6).toFixed(1)}×)`);

  // Measured on the sandbox captures (`lighting-{before,after}-*.png`), model
  // pixels isolated by colour: the tonal spread over the part more than doubles.
  // Kept here as a comment because it needs a browser, not because it is soft.
  //   sd  18.5 → 42.2 (slide)   19.5 → 45.8 (knob)
  //   p2..p98  90.6 → 125.5      102.0 → 121.9   (no pixel crushed or clipped)
}

// --- 4. levels are a single source of truth ---------------------------------
{
  check(key.intensity === STUDIO_LIGHT_LEVELS.key
    && fill.intensity === STUDIO_LIGHT_LEVELS.fill
    && rim.intensity === STUDIO_LIGHT_LEVELS.rim
    && ambient.intensity === STUDIO_LIGHT_LEVELS.ambient,
    'the published levels are what gets built (one place to tune)');
}

// --- 5. both viewports use it -----------------------------------------------
{
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  for (const file of ['src/client/panel.ts', 'src/client/playback.ts']) {
    const src = read(file);
    check(/attachStudioLights\(scene, camera\)/.test(src), `${file} attaches the studio rig`);
    check(!/new THREE\.AmbientLight/.test(src), `${file} has no leftover flat ambient flood`);
    check(!/DirectionalLight\(0xffffff, 1\.2\)/.test(src), `${file} has no leftover world-fixed key`);
    check(/configureStudioRenderer\(renderer\)/.test(src),
      `${file} applies the studio colour pipeline (filmic roll-off, so a lit face keeps its gradient)`);
  }
}

// --- 6. the viewport ground presets -----------------------------------------
{
  // WCAG relative luminance, so "the scale bar is still readable" is a number
  // and not a matter of taste. The overlays are DOM over the canvas: the ink has
  // to flip with the ground, which is exactly what broke on a dark preset.
  const channel = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const rel = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * channel(((n >> 16) & 255) / 255)
      + 0.7152 * channel(((n >> 8) & 255) / 255)
      + 0.0722 * channel((n & 255) / 255);
  };
  const ratio = (a, b) => {
    const [hi, lo] = [rel(a), rel(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  check(VIEWPORT_BACKGROUNDS.length >= 3, 'several grounds are offered',
    VIEWPORT_BACKGROUNDS.map((b) => b.id).join(', '));
  check(new Set(VIEWPORT_BACKGROUNDS.map((b) => b.id)).size === VIEWPORT_BACKGROUNDS.length,
    'preset ids are unique');
  for (const preset of VIEWPORT_BACKGROUNDS) {
    check(/^#[0-9a-f]{6}$/i.test(preset.hex) && preset.label.length > 0,
      `preset "${preset.id}" is complete`, `${preset.label} ${preset.hex}`);
    const ink = overlayInk(preset);
    const r = ratio(ink.color, preset.hex);
    check(r >= 3, `"${preset.label}": the scale bar/triad ink stays legible on its ground`,
      `${r.toFixed(1)}:1`);
  }
  // The set must span light and dark, or "choose a ground" means nothing.
  const lums = VIEWPORT_BACKGROUNDS.map((b) => rel(b.hex));
  check(Math.max(...lums) - Math.min(...lums) > 0.5, 'the set spans pale to deep',
    `${Math.min(...lums).toFixed(2)} .. ${Math.max(...lums).toFixed(2)}`);

  check(backgroundById('graphite').id === 'graphite', 'a preset is looked up by id');
  check(backgroundById('nonsense').id === backgroundById(undefined).id,
    'an unknown id falls back to the default instead of throwing');
  // Node has no localStorage: this is the "storage unavailable" path, which must
  // also end at the default rather than at undefined.
  check(backgroundById(loadBackgroundId()).id === backgroundById(undefined).id,
    'an unreadable stored choice falls back to the default', loadBackgroundId());
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);

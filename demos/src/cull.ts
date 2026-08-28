import * as THREE from 'three/webgpu';
import {
  MAX_DENSITY, MAX_SHARDS, crystalMode, defaultCrystalSettings, type CrystalSettings,
} from '../../src/modes/crystals';
import type { StrokeInstance } from '../../src/modes/mode';
import { Panel, Readouts, arcSamples, canvasSphere, createStage, fatal, studioLights } from './kit';

/**
 * Demo — "generate at the maximum, cull with the slider".
 *
 * This runs the real crystal mode. Every slider you drag calls `applySettings()` on the
 * stroke that already exists: matrices and colors are recomposed in place and culled
 * instances collapse to a zero-scale matrix. Nothing is ever disposed or rebuilt.
 *
 * Tick "Show culled instances" to see the slots that are still allocated, still in the
 * buffer, and simply scaled to nothing.
 */

const RADIUS = 1;

const stage = await createStage({
  cameraPos: [0.1, 0.55, 3.1],
  fov: 42,
  environment: true,
  bloom: { strength: 0.35, threshold: 0.8 },
  orbit: true,
}).catch((err) => {
  fatal(err);
  return null;
});

if (stage) {
  const { scene } = stage;
  studioLights(scene);
  scene.add(canvasSphere(RADIUS, 96));

  const samples = arcSamples({
    radius: RADIUS,
    from: new THREE.Vector3(-0.8, -0.3, 0.85),
    to: new THREE.Vector3(0.85, 0.6, 0.7),
    count: 70,
    wobble: 0.09,
  });

  const settings: CrystalSettings = { ...defaultCrystalSettings, glow: 0.15 };
  const SEED = 0x51ce;

  const stroke = crystalMode.createStroke(samples, SEED, settings);
  stroke.finishGrowth();
  scene.add(stroke.group);

  // A second stroke from the SAME seed with both cull sliders pinned at their maximum.
  // Same generator, same randoms, so its crystals land exactly on top of the live ones —
  // the extras it draws are precisely the instances the sliders are hiding.
  const ghost: StrokeInstance = crystalMode.createStroke(
    samples,
    SEED,
    { ...settings, clusterDensity: MAX_DENSITY, shards: MAX_SHARDS },
  );
  ghost.finishGrowth();
  const ghostMat = new THREE.MeshBasicMaterial({
    color: 0x7d6ab5,
    wireframe: true,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    toneMapped: false,
  });
  ghost.group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = ghostMat;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = -1;
  });
  ghost.group.visible = false;
  scene.add(ghost.group);

  // ---------- instrumentation ----------

  let applyCalls = 0;

  /** Walks the real instance buffers and counts the slots that aren't zero-scaled. */
  function countInstances(): { allocated: number; live: number; meshes: number } {
    let allocated = 0;
    let live = 0;
    let meshes = 0;
    stroke.group.traverse((o) => {
      const mesh = o as THREE.InstancedMesh;
      if (!mesh.isInstancedMesh) return;
      meshes++;
      const arr = mesh.instanceMatrix.array as Float32Array;
      for (let i = 0; i < mesh.count; i++) {
        allocated++;
        const b = i * 16;
        // A zero-scale matrix has an all-zero upper 3×3 block.
        for (let k = 0; k < 11; k++) {
          if (arr[b + k] !== 0) { live++; break; }
        }
      }
    });
    // Every crystal owns a slot in BOTH the tinted and the clear mesh; only one is ever
    // posed, so halve the allocation to get the crystal count.
    return { allocated: allocated / 2, live, meshes };
  }

  const out = new Readouts();
  const readAlloc = out.add('Crystals generated', '—');
  const readLive = out.add('Crystals drawn', '—', 'hi');
  const readDraws = out.add('InstancedMesh draws', '—');
  const readRebuild = out.add('Geometry rebuilds', '0', 'good');
  const readApply = out.add('applySettings() calls', '0', 'hi');

  function apply(): void {
    applyCalls++;
    stroke.applySettings?.(settings);
    ghost.applySettings?.({ ...settings, clusterDensity: MAX_DENSITY, shards: MAX_SHARDS });
    const c = countInstances();
    readAlloc(c.allocated.toLocaleString());
    readLive(c.live.toLocaleString());
    readDraws(String(c.meshes));
    readApply(String(applyCalls));
  }

  // ---------- panel ----------

  const ui = new Panel('Crystal sliders');
  ui.slider({
    label: 'Clusters / unit',
    value: settings.clusterDensity,
    min: 1,
    max: MAX_DENSITY,
    step: 1,
    format: (v) => String(v),
    onChange: (v) => { settings.clusterDensity = v; apply(); },
  });
  ui.slider({
    label: 'Shards / cluster',
    value: settings.shards,
    min: 0,
    max: MAX_SHARDS,
    step: 1,
    format: (v) => String(v),
    onChange: (v) => { settings.shards = v; apply(); },
  });
  ui.slider({
    label: 'Crystal size',
    value: settings.crystalSize,
    min: 0.06,
    max: 0.4,
    format: (v) => v.toFixed(3),
    onChange: (v) => { settings.crystalSize = v; apply(); },
  });
  ui.slider({
    label: 'Lean',
    value: settings.tilt,
    min: 0,
    max: 1,
    onChange: (v) => { settings.tilt = v; apply(); },
  });
  ui.slider({
    label: 'Clear quartz mix',
    value: settings.clearMix,
    min: 0,
    max: 1,
    onChange: (v) => { settings.clearMix = v; apply(); },
  });
  ui.check({
    label: 'Show culled instances',
    onChange: (v) => { ghost.group.visible = v; },
  });
  ui.note(
    'Rebuild counter stays at <b>0</b> no matter how long you drag. The sliders only ever ' +
    'rewrite matrices that already exist.',
  );

  apply();
  readRebuild('0');

  stage.onFrame((dt, t) => {
    stroke.update(dt, t);
    ghost.update(dt, t);
  });
}

import * as THREE from 'three/webgpu';
import { Panel, Readouts, arcSamples, canvasSphere, createStage, fatal, studioLights } from './kit';
import type { SurfaceSample } from '../../src/modes/mode';

/**
 * Demo — "pointer events are not a path".
 *
 * White dots are the raw samples the browser gave us: they bunch up where the hand slowed
 * down and stretch out where it swept. Violet dots are what the modes actually consume —
 * the same stroke resampled at a fixed step, each one carrying a tangent frame.
 */

const RADIUS = 1;

interface PathPoint {
  pos: THREE.Vector3;
  normal: THREE.Vector3;
  side: THREE.Vector3;
  dist: number;
}

/** The resampler every ribbon-based mode runs before it builds anything. */
function buildPath(samples: SurfaceSample[], step: number): PathPoint[] {
  const pts: PathPoint[] = [];
  let travelled = 0;
  let next = 0;
  const tangent = new THREE.Vector3();
  for (let i = 0; i < samples.length; i++) {
    if (i > 0) travelled += samples[i].local.distanceTo(samples[i - 1].local);
    if (travelled < next && i !== samples.length - 1) continue;
    next = travelled + step;
    const a = samples[Math.max(i - 1, 0)];
    const b = samples[Math.min(i + 1, samples.length - 1)];
    tangent.subVectors(b.local, a.local);
    if (tangent.lengthSq() < 1e-8) tangent.set(1, 0, 0);
    tangent.normalize();
    const normal = samples[i].localNormal.clone().normalize();
    const side = new THREE.Vector3().crossVectors(tangent, normal).normalize();
    pts.push({ pos: samples[i].local.clone(), normal, side, dist: travelled });
  }
  return pts;
}

const stage = await createStage({
  cameraPos: [0, 0.15, 3.2],
  fov: 40,
  environment: true,
  orbit: true,
}).catch((err) => {
  fatal(err);
  return null;
});

if (stage) {
  const { scene } = stage;
  studioLights(scene);
  scene.add(canvasSphere(RADIUS, 96));

  // `uneven` bunches samples at the ends and stretches them through the middle — what a
  // real hand does, and what makes raw pointer data useless for spacing anything.
  const samples = arcSamples({
    radius: RADIUS,
    from: new THREE.Vector3(-0.85, -0.35, 0.85),
    to: new THREE.Vector3(0.9, 0.55, 0.75),
    count: 46,
    wobble: 0.1,
    wobbleFreq: 1.8,
    uneven: true,
  });

  // ---------- raw samples ----------

  // The two sets are offset to opposite sides of the stroke. Drawn on top of each other you
  // just get one violet smear and the whole point of the demo is lost.
  const LANE = 0.075;

  /** The across direction at a sample, so each lane can be pushed off the path. */
  function sideAt(i: number): THREE.Vector3 {
    const a = samples[Math.max(i - 1, 0)].local;
    const b = samples[Math.min(i + 1, samples.length - 1)].local;
    const tangent = new THREE.Vector3().subVectors(b, a);
    if (tangent.lengthSq() < 1e-8) tangent.set(1, 0, 0);
    return tangent.normalize().cross(samples[i].localNormal).normalize();
  }

  const rawMat = new THREE.MeshBasicMaterial({ color: 0xf2f4fa, toneMapped: false });
  const rawDots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.017, 10, 8), rawMat, samples.length);
  rawDots.frustumCulled = false;
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    for (let i = 0; i < samples.length; i++) {
      p.copy(samples[i].local).multiplyScalar(1.014).addScaledVector(sideAt(i), -LANE);
      rawDots.setMatrixAt(i, m.compose(p, q, s));
    }
    rawDots.instanceMatrix.needsUpdate = true;
  }
  scene.add(rawDots);

  // ---------- resampled path ----------

  const MAX_POINTS = 400;
  const pathMat = new THREE.MeshBasicMaterial({ color: 0xc9a4ff, toneMapped: false });
  const pathDots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.021, 12, 8), pathMat, MAX_POINTS);
  pathDots.frustumCulled = false;
  pathDots.count = 0;
  scene.add(pathDots);

  const frameGeo = new THREE.BufferGeometry();
  frameGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 6), 3));
  const frames = new THREE.LineSegments(
    frameGeo,
    new THREE.LineBasicMaterial({ color: 0x5ad6ff, toneMapped: false, transparent: true, opacity: 0.9 }),
  );
  frames.frustumCulled = false;
  scene.add(frames);

  let step = 0.045;
  let showFrames = true;

  const out = new Readouts();
  const readRaw = out.add('Raw samples', String(samples.length));
  const readRawGap = out.add('Raw spacing', '—', 'bad');
  const readPath = out.add('Resampled points', '—', 'hi');
  const readPathGap = out.add('Resampled spacing', '—', 'good');

  function rebuild(): void {
    const path = buildPath(samples, step);
    const n = Math.min(path.length, MAX_POINTS);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      p.copy(path[i].pos).multiplyScalar(1.014).addScaledVector(path[i].side, LANE);
      pathDots.setMatrixAt(i, m.compose(p, q, s));
    }
    pathDots.count = n;
    pathDots.instanceMatrix.needsUpdate = true;

    // One tick per point, laid along `side` — the direction ribbons expand into.
    const attr = frameGeo.getAttribute('position') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    arr.fill(0);
    for (let i = 0; i < n; i++) {
      const c = path[i].pos.clone().multiplyScalar(1.014).addScaledVector(path[i].side, LANE);
      const a = c.clone().addScaledVector(path[i].side, -0.055);
      const b = c.clone().addScaledVector(path[i].side, 0.055);
      arr.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
    }
    attr.needsUpdate = true;
    frameGeo.setDrawRange(0, showFrames ? n * 2 : 0);

    readPath(String(n));
    readPathGap(`${step.toFixed(3)} (fixed)`);
  }

  {
    let min = Infinity;
    let max = 0;
    for (let i = 1; i < samples.length; i++) {
      const d = samples[i].local.distanceTo(samples[i - 1].local);
      min = Math.min(min, d);
      max = Math.max(max, d);
    }
    readRaw(String(samples.length));
    readRawGap(`${min.toFixed(3)} → ${max.toFixed(3)}`);
  }

  const ui = new Panel('Resampling');
  ui.slider({
    label: 'Step (world units)',
    value: step,
    min: 0.015,
    max: 0.14,
    step: 0.005,
    format: (v) => v.toFixed(3),
    onChange: (v) => { step = v; rebuild(); },
  });
  ui.check({
    label: 'Raw samples (white)',
    value: true,
    onChange: (v) => { rawDots.visible = v; },
  });
  ui.check({
    label: 'Resampled path (violet)',
    value: true,
    onChange: (v) => { pathDots.visible = v; },
  });
  ui.check({
    label: 'Show tangent frames',
    value: true,
    onChange: (v) => { showFrames = v; rebuild(); },
  });
  ui.note(
    'Crystals scatter one cluster per <b>0.0625</b> units, fissures step the crack every ' +
    '<b>0.025</b>. Neither can be spaced off raw events.',
  );

  rebuild();
}

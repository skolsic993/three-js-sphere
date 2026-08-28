import * as THREE from 'three/webgpu';
import { defaultFissureSettings, fissureMode, type FissureSettings } from '../../src/modes/fissures';
import { Panel, Readouts, arcSamples, canvasSphere, createStage, fatal, studioLights } from './kit';

/**
 * Demo — "the ribbon has no width".
 *
 * This is the real fissure mode. Its crack is one indexed strip whose vertices all sit on
 * the centerline: every vertex has a twin at exactly the same position, and the only thing
 * separating them is `aSide × uWidth × 0.5 × aAcross` in the vertex stage.
 *
 * Turn on "Source vertices" and drag the width slider — the dots never move.
 */

const RADIUS = 1;

const stage = await createStage({
  cameraPos: [0.1, 0.5, 2.9],
  fov: 42,
  environment: true,
  bloom: { strength: 0.5, threshold: 0.7 },
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
    from: new THREE.Vector3(-0.8, -0.35, 0.85),
    to: new THREE.Vector3(0.85, 0.5, 0.75),
    count: 70,
    wobble: 0.08,
  });

  const settings: FissureSettings = { ...defaultFissureSettings, emberRate: 14 };
  const stroke = fissureMode.createStroke(samples, 0xf1552e, settings);
  stroke.finishGrowth();
  scene.add(stroke.group);

  // Pull the pieces of the stroke apart so the demo can show them one at a time.
  const ribbonMeshes: THREE.Mesh[] = [];
  const extras: THREE.Object3D[] = [];
  stroke.group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry.getAttribute('aAcross')) ribbonMeshes.push(mesh);
    else extras.push(mesh);
  });
  const [underMesh, coreMesh] = ribbonMeshes; // added in that order by the mode
  const ribbonGeo = coreMesh.geometry;

  // ---------- the source vertices ----------

  // Each path point emits two vertices at the SAME position (aAcross = -1 and +1), so
  // plotting every second one gives exactly the centerline the mode walked.
  const posAttr = ribbonGeo.getAttribute('position') as THREE.BufferAttribute;
  const pairCount = Math.floor(posAttr.count / 2);
  const dots = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.007, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xffe8b0, toneMapped: false, depthTest: false }),
    pairCount,
  );
  dots.frustumCulled = false;
  dots.renderOrder = 20;
  dots.visible = false;
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    for (let i = 0; i < pairCount; i++) {
      p.fromBufferAttribute(posAttr, i * 2);
      // Nudge along the surface normal so the dots read on top of the glow.
      dots.setMatrixAt(i, m.compose(p.multiplyScalar(1.004), q, s));
    }
    dots.instanceMatrix.needsUpdate = true;
  }
  stroke.group.add(dots);

  // ---------- panel ----------

  let applyCalls = 0;
  const out = new Readouts();
  out.add('Ribbon vertices', posAttr.count.toLocaleString());
  out.add('Centerline points', pairCount.toLocaleString(), 'hi');
  out.add('Triangles', ((ribbonGeo.getIndex()?.count ?? 0) / 3).toLocaleString());
  const readRebuild = out.add('Geometry rebuilds', '0', 'good');
  const readApply = out.add('Uniform writes', '0', 'hi');

  function apply(): void {
    applyCalls++;
    stroke.applySettings?.(settings);
    readApply(String(applyCalls));
    readRebuild('0');
  }

  const ui = new Panel('Fissure ribbon');
  ui.slider({
    label: 'Crack width',
    value: settings.width,
    min: 0.02,
    max: 0.16,
    format: (v) => v.toFixed(3),
    onChange: (v) => { settings.width = v; apply(); },
  });
  ui.slider({
    label: 'Branches / unit',
    value: settings.branchDensity,
    min: 0,
    max: 8,
    step: 0.1,
    format: (v) => v.toFixed(1),
    onChange: (v) => { settings.branchDensity = v; apply(); },
  });
  ui.slider({
    label: 'Branch length',
    value: settings.branchLength,
    min: 0.05,
    max: 0.6,
    format: (v) => v.toFixed(2),
    onChange: (v) => { settings.branchLength = v; apply(); },
  });
  ui.slider({
    label: 'Heat',
    value: settings.heat,
    min: 0.2,
    max: 3,
    onChange: (v) => { settings.heat = v; apply(); },
  });

  let wireframe = false;
  let shaded = true;
  const sync = (): void => {
    coreMesh.visible = shaded;
    underMesh.visible = shaded && !wireframe;
    (coreMesh.material as THREE.Material & { wireframe: boolean }).wireframe = wireframe;
  };
  ui.check({
    label: 'Source vertices',
    onChange: (v) => { dots.visible = v; },
  });
  ui.check({
    label: 'Wireframe',
    onChange: (v) => { wireframe = v; sync(); },
  });
  ui.check({
    label: 'Shaded crack',
    value: true,
    onChange: (v) => { shaded = v; sync(); },
  });
  ui.check({
    label: 'Rock lips + embers',
    value: true,
    onChange: (v) => { for (const e of extras) e.visible = v; },
  });
  ui.note(
    'Branch culling lives in the shader too: <b>step(aRank, uBranchFrac)</b> collapses a ' +
    'whole branch to zero width without touching a buffer.',
  );

  stage.onFrame((dt, t) => stroke.update(dt, t));
}

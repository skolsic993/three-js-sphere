import * as THREE from 'three/webgpu';
import { Panel, Readouts, Replayer, arcSamples, canvasSphere, createStage, fatal, studioLights } from './kit';

/**
 * Demo — "the canvas moves while you paint".
 *
 * Both spheres bob and turn. Both get the exact same stroke, drawn by the same scripted
 * hand. The only difference is which coordinate space the samples were stored in at pick
 * time: world (left) or the anchor's local space (right).
 *
 * The bug on the left is the whole reason SurfaceSample carries `local`/`localNormal`.
 */

const RADIUS = 0.85;
const BEAD_RADIUS = 0.03;

const stage = await createStage({
  cameraPos: [0, 0.35, 4.6],
  fov: 46,
  environment: true,
  orbit: true,
}).catch((err) => {
  fatal(err);
  return null;
});

if (stage) {
  const { scene } = stage;
  stage.controls?.target.set(0, 0, 0);
  studioLights(scene);

  const beadGeo = new THREE.SphereGeometry(BEAD_RADIUS, 12, 8);
  const beadMat = new THREE.MeshBasicMaterial({ color: 0xc9a4ff, toneMapped: false });

  /** One half of the split: a floating canvas plus the beads painted onto it. */
  function makeSide(x: number, parentBeadsToAnchor: boolean): {
    root: THREE.Group;
    beads: THREE.InstancedMesh;
    place: (index: number, local: THREE.Vector3, normal: THREE.Vector3) => void;
    reset: () => void;
  } {
    const root = new THREE.Group();
    root.position.x = x;
    scene.add(root);

    const sphere = canvasSphere(RADIUS, 64);
    root.add(sphere);

    const beads = new THREE.InstancedMesh(beadGeo, beadMat, 200);
    beads.frustumCulled = false;
    beads.count = 0;
    // Left: beads live in the world, exactly where the pointer hit at pick time.
    // Right: beads are parented under the anchor, so they ride whatever it does next.
    (parentBeadsToAnchor ? root : scene).add(beads);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();

    return {
      root,
      beads,
      place(index, local, normal) {
        p.copy(local).addScaledVector(normal, BEAD_RADIUS * 0.8);
        if (!parentBeadsToAnchor) {
          // Freeze the WORLD position the pointer reported — the naive version.
          root.updateWorldMatrix(true, false);
          p.applyMatrix4(root.matrixWorld);
        }
        beads.setMatrixAt(index, m.compose(p, q, s));
        beads.count = Math.max(beads.count, index + 1);
        beads.instanceMatrix.needsUpdate = true;
      },
      reset() {
        beads.count = 0;
        beads.instanceMatrix.needsUpdate = true;
      },
    };
  }

  const left = makeSide(-1.25, false);
  const right = makeSide(1.25, true);

  // The same painted path for both, in each sphere's local space.
  const samples = arcSamples({
    radius: RADIUS,
    from: new THREE.Vector3(-0.75, -0.5, 0.9),
    to: new THREE.Vector3(0.8, 0.75, 0.75),
    count: 90,
    wobble: 0.11,
    wobbleFreq: 1.4,
  });

  let spin = 0.55;
  let drawn = 0;

  const replay = new Replayer(2.6, 3.4, () => {
    drawn = 0;
    left.reset();
    right.reset();
  });

  const ui = new Panel('Floating canvas');
  ui.slider({
    label: 'Canvas spin',
    value: spin,
    min: 0,
    max: 1.6,
    format: (v) => `${v.toFixed(2)} rad/s`,
    onChange: (v) => { spin = v; },
  });
  ui.button('▶ Replay the stroke', () => replay.restart());
  ui.note(
    'The pointer traced the <b>same path</b> on both. Only the stored coordinate space ' +
    'differs — and the sphere keeps turning after you let go.',
  );

  const out = new Readouts();
  const readDrawn = out.add('Samples painted', '0 / 90', 'hi');
  const readDrift = out.add('World-space drift', '0.00', 'bad');

  const worldA = new THREE.Vector3();
  const worldB = new THREE.Vector3();
  const readMat = new THREE.Matrix4();
  const readQuat = new THREE.Quaternion();
  const readScale = new THREE.Vector3();

  stage.onFrame((dt, time) => {
    // Both canvases float: a slow bob plus a steady turn, exactly like the app's floatRoot.
    for (const side of [left, right]) {
      side.root.rotation.y += spin * dt;
      side.root.position.y = Math.sin(time * 0.9) * 0.06;
    }

    const progress = replay.advance(dt);
    const want = Math.floor(progress * samples.length);
    while (drawn < want) {
      const s = samples[drawn];
      left.place(drawn, s.local, s.localNormal);
      right.place(drawn, s.local, s.localNormal);
      drawn++;
    }
    readDrawn(`${drawn} / ${samples.length}`);

    // How far the first bead has slipped from the surface point it was painted on.
    if (drawn > 0) {
      const s = samples[0];
      left.beads.getMatrixAt(0, readMat);
      readMat.decompose(worldA, readQuat, readScale);
      left.root.updateWorldMatrix(true, false);
      worldB.copy(s.local).applyMatrix4(left.root.matrixWorld);
      readDrift(`${worldA.distanceTo(worldB).toFixed(2)} units`);
    } else {
      readDrift('0.00 units');
    }
  });
}

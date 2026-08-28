import * as THREE from 'three/webgpu';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { float, hash, instanceIndex, mix, positionLocal, positionWorld, smoothstep, time, uniform, vec3 } from 'three/tsl';
import { mulberry32 } from '../../src/modes/mode';
import { Panel, Readouts, createStage, fatal } from './kit';

/**
 * Demo — "one heartbeat for the whole reef".
 *
 * The reef's polyps don't own a timer. Their brightness is read out of a wave that lives in
 * WORLD space, so every colony — every separate stroke, painted minutes apart — lights up
 * in the right order automatically. The floor is shaded with the same expression, which is
 * why you can see the wavefront arrive.
 *
 * Switch to per-colony phase and the illusion collapses into three unrelated blinkers.
 */

const uPulse = uniform(1);
const uSharp = uniform(2.5);
const uGlow = uniform(1.2);
const uDir = uniform(new THREE.Vector3(1.6, 1.1, 1.35));
const uGlowA = uniform(new THREE.Color(0x2ee6d6));
const uGlowB = uniform(new THREE.Color(0x4e8aff));

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-function-return-type */
const colorVec = (u: unknown) => vec3(u as any);

/** The production expression, verbatim apart from the direction being a uniform here. */
function colonyPulse() {
  return positionWorld.dot(colorVec(uDir)).mul(2.6)
    .sub(time.mul(uPulse.mul(2.1)))
    .sin().mul(0.5).add(0.5).pow(uSharp);
}

/** The naive alternative: each colony keeps its own clock, in its own local space. */
function localPulse(phase: number) {
  return positionLocal.dot(colorVec(uDir)).mul(2.6)
    .sub(time.mul(uPulse.mul(2.1)).add(phase))
    .sin().mul(0.5).add(0.5).pow(uSharp);
}
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-function-return-type */

const stage = await createStage({
  cameraPos: [-0.5, 3.1, 6.6],
  target: [-0.5, 0.3, 0],
  fov: 44,
  bloom: { strength: 0.7, threshold: 0.5 },
  orbit: true,
}).catch((err) => {
  fatal(err);
  return null;
});

if (stage) {
  const { scene } = stage;

  // ---------- the floor, shaded with the same wave ----------

  const floorMat = new MeshBasicNodeMaterial();
  // Fade the floor out with distance instead of letting its far edge cut across the frame.
  const horizon = float(1).sub(smoothstep(5, 20, positionWorld.length()));
  floorMat.colorNode = vec3(0.03, 0.045, 0.07)
    .add(colorVec(uGlowA).mul(colonyPulse()).mul(0.16))
    .mul(horizon);
  // The wave is evaluated per fragment from positionWorld, so one quad is enough — it just
  // has to be big enough that its far edge never enters frame.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(46, 46), floorMat);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // ---------- three colonies ----------

  const rnd = mulberry32(0x1eef);
  const tipGeo = new THREE.IcosahedronGeometry(1, 1);

  const worldMat = new MeshBasicNodeMaterial();
  {
    const blink = time.mul(0.8).add(hash(instanceIndex).mul(6.283)).sin().mul(0.15).add(0.85);
    const c = mix(colorVec(uGlowA), colorVec(uGlowB), hash(instanceIndex.add(9)));
    worldMat.colorNode = c.mul(colonyPulse().mul(2.6).add(0.2)).mul(blink).mul(uGlow);
  }

  interface Colony {
    group: THREE.Group;
    localMat: MeshBasicNodeMaterial;
    mesh: THREE.InstancedMesh;
  }

  const colonies: Colony[] = [];
  const centres: [number, number][] = [[-2.8, 0.3], [-0.5, -0.4], [1.8, 0.5]];

  centres.forEach(([cx, cz], ci) => {
    const group = new THREE.Group();
    group.position.set(cx, 0, cz);
    scene.add(group);

    const localMat = new MeshBasicNodeMaterial();
    const blink = time.mul(0.8).add(hash(instanceIndex).mul(6.283)).sin().mul(0.15).add(0.85);
    const c = mix(colorVec(uGlowA), colorVec(uGlowB), hash(instanceIndex.add(9)));
    localMat.colorNode = c.mul(localPulse(ci * 2.1).mul(2.6).add(0.2)).mul(blink).mul(uGlow);

    // A scruffy little colony: polyps scattered on a few upright stalks.
    const N = 70;
    const mesh = new THREE.InstancedMesh(tipGeo, worldMat, N);
    mesh.frustumCulled = false;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.pow(rnd(), 0.6) * 0.75;
      p.set(Math.cos(a) * r, 0.06 + Math.pow(rnd(), 1.6) * 0.85, Math.sin(a) * r);
      s.setScalar(0.028 + rnd() * 0.03);
      mesh.setMatrixAt(i, m.compose(p, q, s));
    }
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);

    colonies.push({ group, localMat, mesh });
  });

  // ---------- panel ----------

  let drift = true;

  const out = new Readouts();
  const readMode = out.add('Pulse source', 'positionWorld', 'good');
  const readColonies = out.add('Colonies', '3 · one shared wave');

  const ui = new Panel('Colony pulse');
  ui.check({
    label: 'World-space wave',
    value: true,
    onChange: (v) => {
      for (const c of colonies) c.mesh.material = v ? worldMat : c.localMat;
      floor.visible = v;
      readMode(v ? 'positionWorld' : 'positionLocal + phase', v ? 'good' : 'bad');
      readColonies(v ? '3 · one shared wave' : '3 · three private clocks');
    },
  });
  ui.check({
    label: 'Drift the middle colony',
    value: true,
    onChange: (v) => { drift = v; },
  });
  ui.slider({
    label: 'Pulse speed',
    value: 1,
    min: 0,
    max: 3,
    onChange: (v) => { uPulse.value = v; },
  });
  ui.slider({
    label: 'Wave sharpness',
    value: 2.5,
    min: 1,
    max: 8,
    onChange: (v) => { uSharp.value = v; },
  });
  ui.slider({
    label: 'Wave heading',
    value: 0,
    min: -Math.PI,
    max: Math.PI,
    format: (v) => `${Math.round((v * 180) / Math.PI)}°`,
    onChange: (v) => {
      const d = uDir.value as THREE.Vector3;
      d.set(Math.cos(v) * 1.9, 1.1, Math.sin(v) * 1.9);
    },
  });
  ui.slider({
    label: 'Bioluminescence',
    value: 1.2,
    min: 0,
    max: 2.5,
    onChange: (v) => { uGlow.value = v; },
  });
  ui.note(
    'With <b>positionWorld</b>, moving a colony moves it <i>through</i> the wave. With a ' +
    'local phase it carries its own beat around and nothing lines up.',
  );

  stage.onFrame((_dt, t) => {
    const middle = colonies[1].group;
    middle.position.x = drift ? -0.5 + Math.sin(t * 0.45) * 1.3 : -0.5;
  });
}

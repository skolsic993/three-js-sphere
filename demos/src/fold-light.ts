import * as THREE from 'three/webgpu';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { abs, cos, float, mix, positionLocal, smoothstep, time, uniform, vec3 } from 'three/tsl';
import { Panel, createStage, fatal } from './kit';

/**
 * Demo — "light the folds, not the sheet".
 *
 * Both curtains run the identical vertex wave. The left one is evenly lit; the right one
 * multiplies its colour by |cos(foldPhase)| — the *same phase* that displaced the vertices.
 * That single shared term is what turns a wobbling plane into fabric.
 *
 * The offset slider breaks the link on purpose: push the fragment phase away from the
 * vertex phase and the light slides off the folds it is supposed to belong to.
 */

const WIDTH = 2.1;
const HEIGHT = 1.15;

const stage = await createStage({
  cameraPos: [0, 0.5, 3.5],
  target: [0, 0.45, 0],
  fov: 46,
  bloom: { strength: 0.4, threshold: 0.7 },
  orbit: true,
}).catch((err) => {
  fatal(err);
  return null;
});

if (stage) {
  const { scene } = stage;

  const uWave = uniform(0.55);
  const uFlow = uniform(1);
  const uOffset = uniform(0);
  const uBright = uniform(1);

  const HEM = new THREE.Color(0x3cffa8);
  const MID = new THREE.Color(0x36c9ff);
  const TOP = new THREE.Color(0xb26bff);

  /** One curtain. `foldLocked` decides whether the fragment stage knows about the wave. */
  function curtain(foldLocked: boolean): THREE.Mesh {
    const mat = new MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;
    mat.blending = THREE.AdditiveBlending;

    const aDist = positionLocal.x;
    const aV = positionLocal.y.div(HEIGHT);
    const T = time.mul(uFlow);

    // ----- vertex: two travelling waves, amplitude growing with height -----
    const foldPhase = aDist.mul(6.3).add(T.mul(1.1));
    const amp = uWave.mul(0.34).mul(aV.pow(1.35));
    const sway = foldPhase.sin()
      .add(aDist.mul(11.7).sub(T.mul(0.7)).add(aV.mul(1.8)).sin().mul(0.5));
    mat.positionNode = positionLocal.add(vec3(0, 0, amp.mul(sway)));

    // ----- fragment -----
    let grad = mix(vec3(HEM.r, HEM.g, HEM.b), vec3(MID.r, MID.g, MID.b), smoothstep(0.03, 0.45, aV));
    grad = mix(grad, vec3(TOP.r, TOP.g, TOP.b), smoothstep(0.45, 0.95, aV));

    // The whole trick, in one line: reuse foldPhase from the vertex stage.
    // 0.95 is the average value of the fold term, so both curtains carry the same
    // overall brightness and the only difference on screen is where the light sits.
    const folds = foldLocked
      ? abs(cos(foldPhase.add(uOffset))).pow(1.6).mul(0.85).add(0.4)
      : float(0.95);

    const hemBoost = smoothstep(0.0, 0.22, aV).oneMinus().mul(1.3).add(1);
    mat.colorNode = grad.mul(folds).mul(hemBoost).mul(uBright).mul(1.3);

    const endFade = smoothstep(0.0, 0.18, abs(aDist).oneMinus());
    mat.opacityNode = float(1).sub(aV).pow(1.15).mul(endFade).mul(0.9);

    const geo = new THREE.PlaneGeometry(WIDTH, HEIGHT, 160, 30);
    geo.translate(0, HEIGHT / 2, 0); // hem pinned at y = 0
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    return mesh;
  }

  const left = curtain(false);
  left.position.x = -1.2;
  const right = curtain(true);
  right.position.x = 1.2;
  scene.add(left, right);

  // A dim floor line under each hem, so "the hem stays pinned" is visible.
  for (const x of [-1.2, 1.2]) {
    const hem = new THREE.Mesh(
      new THREE.PlaneGeometry(WIDTH, 0.02),
      new THREE.MeshBasicMaterial({ color: 0x2a3350, toneMapped: false }),
    );
    hem.position.set(x, 0, 0);
    scene.add(hem);
  }

  const ui = new Panel('Curtain');
  ui.slider({
    label: 'Billow',
    value: 0.55,
    min: 0,
    max: 1,
    onChange: (v) => { uWave.value = v; },
  });
  ui.slider({
    label: 'Flow speed',
    value: 1,
    min: 0,
    max: 3,
    onChange: (v) => { uFlow.value = v; },
  });
  ui.slider({
    label: 'Fragment phase offset',
    value: 0,
    min: 0,
    max: Math.PI * 2,
    format: (v) => `${(v / Math.PI).toFixed(2)}π`,
    onChange: (v) => { uOffset.value = v; },
  });
  ui.slider({
    label: 'Brightness',
    value: 1,
    min: 0.2,
    max: 2.5,
    onChange: (v) => { uBright.value = v; },
  });
  ui.note(
    'Drag the offset away from <b>0</b> and the right curtain stops being cloth — the ' +
    'bright bands drift free of the geometry they are meant to be lighting.',
  );
}

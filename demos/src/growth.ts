import * as THREE from 'three/webgpu';
import { mulberry32 } from '../../src/modes/mode';
import { Panel, Readouts, createStage, fatal, studioLights } from './kit';

/**
 * Demo — "the growth front".
 *
 * Nothing here is on a timer. Every crystal stores the distance along the stroke at which
 * it was seeded (`birth`), the stroke stores how far the front has travelled (`grown`), and
 * the animation is just the difference between the two. That is why growth speed is a live
 * slider and why replaying a stroke costs nothing.
 *
 * Both rows share one front. Only the easing differs.
 */

const COUNT = 34;
const SPAN = 4.2;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

/** The mode's pop: overshoots ~8% then settles, like a crystal snapping into being. */
function easeOutBack(t: number): number {
  const c1 = 1.20158;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

/** A stand-in for the mode's quartz point: hexagonal, tapered, flat-shaded. */
function crystalGeometry(rnd: () => number): THREE.BufferGeometry {
  const sides = 6;
  const positions: number[] = [];
  const lower: THREE.Vector3[] = [];
  const upper: THREE.Vector3[] = [];
  const apex = new THREE.Vector3((rnd() - 0.5) * 0.12, 1, (rnd() - 0.5) * 0.12);
  for (let i = 0; i < sides; i++) {
    const a = ((i + (rnd() - 0.5) * 0.3) / sides) * Math.PI * 2;
    const r = 0.2 * (0.8 + rnd() * 0.4);
    lower.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
    upper.push(new THREE.Vector3(Math.cos(a) * r * 0.85, 0.62, Math.sin(a) * r * 0.85));
  }
  const push = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    push(lower[i], upper[i], upper[j]);
    push(lower[i], upper[j], lower[j]);
    push(upper[i], apex, upper[j]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

const stage = await createStage({
  cameraPos: [0, 0.05, 4.4],
  fov: 46,
  environment: true,
  bloom: { strength: 0.4, threshold: 0.75 },
  orbit: true,
}).catch((err) => {
  fatal(err);
  return null;
});

if (stage) {
  const { scene } = stage;
  studioLights(scene);

  const rnd = mulberry32(0x9e0117);
  const geo = crystalGeometry(rnd);
  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.05,
    transmission: 0.7,
    ior: 1.55,
    thickness: 0.4,
    attenuationColor: new THREE.Color(0x7a2fd6),
    attenuationDistance: 0.5,
    iridescence: 0.4,
    clearcoat: 0.5,
    envMapIntensity: 1.6,
  });

  interface Row {
    mesh: THREE.InstancedMesh;
    ease: (t: number) => number;
  }

  const births: number[] = [];
  const heights: number[] = [];
  for (let i = 0; i < COUNT; i++) {
    births.push((i / (COUNT - 1)) * SPAN + rnd() * 0.06);
    heights.push(0.34 + rnd() * 0.26);
  }

  function makeRow(y: number, ease: (t: number) => number): Row {
    const mesh = new THREE.InstancedMesh(geo, material, COUNT);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.position.set(0, y, 0);
    for (let i = 0; i < COUNT; i++) mesh.setMatrixAt(i, _zero);
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);
    return { mesh, ease };
  }

  const rows: Row[] = [
    makeRow(0.42, (t) => t),          // linear
    makeRow(-0.72, easeOutBack),      // what the modes actually use
  ];

  // ---------- the front marker + its window ----------

  const frontLine = new THREE.Mesh(
    new THREE.PlaneGeometry(0.012, 2.1),
    new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, opacity: 0.85 }),
  );
  const window0 = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 2.1),
    new THREE.MeshBasicMaterial({
      color: 0x8a5cff, toneMapped: false, transparent: true, opacity: 0.035,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  frontLine.position.z = 0.4;
  window0.position.z = 0.38;
  scene.add(frontLine, window0);

  // ---------- state ----------

  let speed = 1.4;
  let growWindow = 0.45;
  let grown = 0;

  const out = new Readouts();
  const readGrown = out.add('Front position', '0.00', 'hi');
  const readBorn = out.add('Crystals born', `0 / ${COUNT}`);
  const readPopping = out.add('Inside the window', '0', 'good');

  const ui = new Panel('Growth');
  ui.slider({
    label: 'Growth speed',
    value: speed,
    min: 0.2,
    max: 4,
    format: (v) => `${v.toFixed(2)} u/s`,
    onChange: (v) => { speed = v; },
  });
  ui.slider({
    label: 'Growth window',
    value: growWindow,
    min: 0.08,
    max: 1.4,
    format: (v) => v.toFixed(2),
    onChange: (v) => { growWindow = v; },
  });
  ui.button('▶ Replay', () => { grown = 0; });
  ui.note(
    'Top row scales linearly. Bottom row runs <b>easeOutBack</b> — that 5% overshoot is the ' +
    'entire difference between "a mesh appeared" and "a crystal snapped into being".' +
    '<svg id="plot" viewBox="0 0 104 62" style="width:100%;margin-top:12px;overflow:visible">' +
    '<line x1="2" y1="52" x2="102" y2="52" stroke="rgba(150,160,200,.35)" stroke-width="1"/>' +
    '<line x1="2" y1="52" x2="2" y2="4" stroke="rgba(150,160,200,.35)" stroke-width="1"/>' +
    '<line x1="2" y1="12" x2="102" y2="12" stroke="rgba(150,160,200,.18)" stroke-width="1" stroke-dasharray="3 3"/>' +
    '<path id="pLin" fill="none" stroke="#8ea0c8" stroke-width="1.6"/>' +
    '<path id="pBack" fill="none" stroke="#c9a4ff" stroke-width="1.8"/>' +
    '<circle id="dLin" r="2.6" fill="#8ea0c8"/>' +
    '<circle id="dBack" r="2.6" fill="#c9a4ff"/>' +
    '</svg>',
  );

  // Plot the two easings once: x = t (0..1), y = scale (0 at the axis, 1 at the dashed line).
  const px = (t: number): number => 2 + t * 100;
  const py = (k: number): number => 52 - k * 40;
  const plotPath = (id: string, fn: (t: number) => number): void => {
    const pts: string[] = [];
    for (let i = 0; i <= 48; i++) {
      const t = i / 48;
      pts.push(`${i === 0 ? 'M' : 'L'}${px(t).toFixed(1)},${py(fn(t)).toFixed(1)}`);
    }
    document.getElementById(id)?.setAttribute('d', pts.join(' '));
  };
  plotPath('pLin', (t) => t);
  plotPath('pBack', easeOutBack);
  const dotLin = document.getElementById('dLin');
  const dotBack = document.getElementById('dBack');

  // ---------- frame ----------

  const mid = Math.floor(COUNT / 2);
  const _p = new THREE.Vector3();

  stage.onFrame((dt) => {
    grown += dt * speed;
    if (grown > SPAN + growWindow + 1.2) grown = 0;

    let born = 0;
    let popping = 0;

    for (const row of rows) {
      for (let i = 0; i < COUNT; i++) {
        const t = (grown - births[i]) / growWindow;
        if (t <= 0) {
          row.mesh.setMatrixAt(i, _zero);
          continue;
        }
        const k = t >= 1 ? 1 : row.ease(t);
        const h = heights[i] * k;
        // Crystals emerge narrower than tall, then relax — the mode does the same.
        const w = heights[i] * k * (0.6 + 0.4 * k) * 0.55;
        _s.set(w, h, w);
        _p.set(-SPAN / 2 + births[i], 0, 0);
        _m.compose(_p, _q, _s);
        row.mesh.setMatrixAt(i, _m);
      }
      row.mesh.instanceMatrix.needsUpdate = true;
    }

    for (let i = 0; i < COUNT; i++) {
      const t = (grown - births[i]) / growWindow;
      if (t > 0) born++;
      if (t > 0 && t < 1) popping++;
    }

    const frontX = -SPAN / 2 + Math.min(grown, SPAN + growWindow);
    frontLine.position.x = frontX;
    frontLine.visible = grown < SPAN + growWindow;
    window0.scale.x = growWindow;
    window0.position.x = frontX - growWindow / 2;
    window0.visible = frontLine.visible;

    readGrown(grown.toFixed(2));
    readBorn(`${born} / ${COUNT}`);
    readPopping(String(popping));

    const tMid = THREE.MathUtils.clamp((grown - births[mid]) / growWindow, 0, 1);
    dotLin?.setAttribute('cx', String(px(tMid)));
    dotLin?.setAttribute('cy', String(py(tMid)));
    dotBack?.setAttribute('cx', String(px(tMid)));
    dotBack?.setAttribute('cy', String(py(easeOutBack(tMid))));
  });
}

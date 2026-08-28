import * as THREE from 'three/webgpu';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { abs, float, mix, positionLocal, smoothstep, time, uniform, vec3 } from 'three/tsl';
import { Panel, createStage, fatal } from './kit';

/**
 * Demo — "a crack is four numbers multiplied together".
 *
 * The fissure core has no texture and no lights. Its colour is a single scalar — heat —
 * pushed through a blackbody-ish ramp. Heat is the product of a handful of terms, and each
 * one does exactly one job. Switch them off one at a time and watch what disappears.
 */

const LEN = 4.4;
const HALF_W = 0.24;
const X_OFF = -0.8; // nudged left so the strip clears the control panel

const stage = await createStage({
  cameraPos: [0, 0, 4.4],
  fov: 50,
  orbit: false,
  // Restrained: the ramp already runs to (4.6, 3.6, 2.4), so a heavy bloom just washes
  // the whole frame out and you can't read the terms any more.
  bloom: { strength: 0.28, threshold: 1.1 },
}).catch((err) => {
  fatal(err);
  return null;
});

if (stage) {
  const { scene, camera } = stage;

  // Term switches, as uniforms so toggling costs nothing.
  const onCenter = uniform(1);
  const onPulse = uniform(1);
  const onFlicker = uniform(1);
  const onFlash = uniform(1);
  const uHeat = uniform(1.5);
  const uPulseSpeed = uniform(1);
  const uGrown = uniform(LEN * 0.55);

  /** The ramp the mode uses: dark seam → deep red → orange → white-hot. */
  /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-function-return-type */
  function blackbody(heat: any) {
    const cSeam = vec3(0.02, 0.004, 0.002);
    const cRed = vec3(1.1, 0.1, 0.01);
    const cOrange = vec3(2.6, 0.85, 0.1);
    const cWhite = vec3(4.6, 3.6, 2.4);
    let color = mix(cSeam, cRed, smoothstep(0.0, 0.55, heat));
    color = mix(color, cOrange, smoothstep(0.55, 1.15, heat));
    return mix(color, cWhite, smoothstep(1.15, 2.1, heat));
  }
  /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-function-return-type */

  // ---------- the crack ----------

  const crackMat = new MeshBasicNodeMaterial();
  crackMat.transparent = true;
  crackMat.depthWrite = false;
  crackMat.blending = THREE.AdditiveBlending;
  {
    // A flat stand-in for the ribbon: x is distance along the crack, y is across it.
    const aDist = positionLocal.x.add(LEN / 2);
    const aAcross = positionLocal.y.div(HALF_W);

    // 1. cross-section: bright at the seam, gone at the lips.
    const center = smoothstep(0.12, 1.0, abs(aAcross)).oneMinus();
    // 2. heat waves travelling along the crack — the "breathing".
    const pulse = aDist.mul(7).sub(time.mul(uPulseSpeed.mul(2.6))).sin().mul(0.28).add(0.72);
    // 3. high-frequency flicker so the light never sits still.
    const flicker = time.mul(9).add(aDist.mul(41)).sin().mul(0.08).add(0.94);
    // 4. the white flash riding the propagation front.
    const flash = smoothstep(0.0, 0.22, abs(uGrown.sub(aDist))).oneMinus().mul(1.6);

    const heat = mix(float(1), center, onCenter)
      .mul(mix(float(1), pulse, onPulse))
      .mul(mix(float(1), flicker, onFlicker))
      .mul(uHeat)
      .add(flash.mul(onFlash));

    crackMat.colorNode = blackbody(heat);
    crackMat.opacityNode = smoothstep(0.82, 1.0, abs(aAcross)).oneMinus();
  }
  const crack = new THREE.Mesh(new THREE.PlaneGeometry(LEN, HALF_W * 2, 480, 8), crackMat);
  crack.position.set(X_OFF, 0.42, 0);
  scene.add(crack);

  // ---------- the ramp legend ----------

  const rampMat = new MeshBasicNodeMaterial();
  rampMat.colorNode = blackbody(positionLocal.x.add(LEN / 2).div(LEN).mul(2.6));
  const ramp = new THREE.Mesh(new THREE.PlaneGeometry(LEN, 0.16, 240, 1), rampMat);
  ramp.position.set(X_OFF, -0.62, 0);
  scene.add(ramp);

  // HTML ticks under the ramp, projected from world space once (the camera is fixed).
  const ticks = document.createElement('div');
  ticks.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:4';
  document.body.appendChild(ticks);
  const tickValues = [0, 0.55, 1.15, 2.1, 2.6];
  const tickLabels = ['seam', 'red', 'orange', 'white-hot', ''];
  const tickEls = tickValues.map((v, i) => {
    const el = document.createElement('div');
    el.style.cssText =
      'position:absolute;transform:translate(-50%,0);font-size:11.5px;color:#97a0b8;' +
      'font-variant-numeric:tabular-nums;text-align:center;white-space:nowrap;' +
      // The white-hot end of the ramp blooms over the labels otherwise.
      'background:rgba(10,12,20,.78);padding:4px 8px 5px;border-radius:7px';
    el.innerHTML = `<div style="width:1px;height:8px;background:rgba(150,160,200,.5);margin:0 auto 4px"></div>` +
      `heat ${v}${tickLabels[i] ? `<br><span style="color:#c9a4ff">${tickLabels[i]}</span>` : ''}`;
    ticks.appendChild(el);
    return el;
  });

  const placeTicks = (): void => {
    const p = new THREE.Vector3();
    for (let i = 0; i < tickValues.length; i++) {
      p.set(X_OFF - LEN / 2 + (tickValues[i] / 2.6) * LEN, ramp.position.y - 0.11, 0);
      p.project(camera);
      tickEls[i].style.left = `${((p.x + 1) / 2) * innerWidth}px`;
      tickEls[i].style.top = `${((1 - p.y) / 2) * innerHeight}px`;
    }
  };
  window.addEventListener('resize', placeTicks);

  // ---------- panel ----------

  let sweep = true;

  const ui = new Panel('Heat terms');
  ui.check({ label: '1 · cross-section', value: true, onChange: (v) => { onCenter.value = v ? 1 : 0; } });
  ui.check({ label: '2 · travelling pulse', value: true, onChange: (v) => { onPulse.value = v ? 1 : 0; } });
  ui.check({ label: '3 · flicker', value: true, onChange: (v) => { onFlicker.value = v ? 1 : 0; } });
  ui.check({ label: '4 · front flash', value: true, onChange: (v) => { onFlash.value = v ? 1 : 0; } });
  ui.slider({
    label: 'Heat',
    value: 1.5,
    min: 0.2,
    max: 3,
    onChange: (v) => { uHeat.value = v; },
  });
  ui.slider({
    label: 'Pulse speed',
    value: 1,
    min: 0,
    max: 3,
    onChange: (v) => { uPulseSpeed.value = v; },
  });
  ui.check({
    label: 'Sweep the front',
    value: true,
    onChange: (v) => { sweep = v; },
  });
  ui.note(
    'Everything above resolves to one float. The ramp underneath is the whole palette: ' +
    'no texture, no lights, four <b>mix()</b> calls.',
  );

  stage.onFrame((dt) => {
    if (sweep) {
      uGrown.value += dt * 1.6;
      if (uGrown.value > LEN + 0.6) uGrown.value = -0.4;
    }
    placeTicks();
  });
}

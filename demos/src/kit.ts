import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { SurfaceSample } from '../../src/modes/mode';
import './demo.css';

/**
 * Shared plumbing for the demo routes.
 *
 * Every route in /demos isolates ONE mechanism from the main app and loops it, so it can be
 * screen-recorded as a short GIF without anyone having to drive it by hand. This module owns
 * the boring half of that: renderer bootstrap, the studio environment, a capture-friendly
 * control panel, and a scripted "hand" that paints the same stroke over and over.
 */

// ---------- stage ----------

export interface StageOptions {
  cameraPos?: [number, number, number];
  target?: [number, number, number];
  fov?: number;
  /** Adds the studio environment map (see ENV_PANELS). */
  environment?: boolean;
  /** Adds the bloom + tone-mapping post chain the main app uses. */
  bloom?: false | { strength: number; threshold: number };
  orbit?: boolean;
  background?: number;
  exposure?: number;
}

export interface Stage {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls | null;
  /** Rebuild the PMREM environment from a subset of ENV_PANELS. */
  setEnvironment(panels: readonly EnvPanel[]): void;
  /** Register a per-frame callback. `dt` is clamped seconds, `t` is seconds since start. */
  onFrame(cb: (dt: number, t: number) => void): void;
  /** Steps and draws exactly one frame. Used by the automated checks. */
  renderOnce(seconds?: number): Promise<void>;
}

/** Boots a WebGPU (or WebGL2-fallback) stage into #stage and starts the render loop. */
export async function createStage(options: StageOptions = {}): Promise<Stage> {
  const container = document.getElementById('stage') as HTMLElement;
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  await renderer.init();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = options.exposure ?? 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(options.background ?? 0x0a0b10);

  const camera = new THREE.PerspectiveCamera(options.fov ?? 42, 1, 0.01, 100);
  camera.position.set(...(options.cameraPos ?? [0, 0.8, 4.2]));

  let controls: OrbitControls | null = null;
  if (options.orbit !== false) {
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 1.2;
    controls.maxDistance = 16;
    controls.target.set(...(options.target ?? [0, 0, 0]));
  } else {
    camera.lookAt(new THREE.Vector3(...(options.target ?? [0, 0, 0])));
  }

  let pmremTexture: THREE.Texture | null = null;
  const setEnvironment = (panels: readonly EnvPanel[]): void => {
    pmremTexture?.dispose();
    pmremTexture = buildEnvironmentTexture(renderer, panels);
    scene.environment = pmremTexture;
  };
  if (options.environment) setEnvironment(ENV_PANELS);

  let post: THREE.PostProcessing | null = null;
  if (options.bloom) {
    const scenePass = pass(scene, camera, { samples: 4 });
    const color = scenePass.getTextureNode();
    post = new THREE.PostProcessing(renderer);
    post.outputNode = color.add(bloom(color, options.bloom.strength, 0.6, options.bloom.threshold));
  }

  const resize = (): void => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  window.addEventListener('resize', resize);
  resize();

  const callbacks: ((dt: number, t: number) => void)[] = [];
  let last = 0;

  const advance = (dt: number, t: number): void => {
    controls?.update();
    for (const cb of callbacks) cb(dt, t);
  };
  const draw = (): void | Promise<void> => (post ? post.render() : renderer.render(scene, camera));
  const step = (dt: number, t: number): void | Promise<void> => {
    advance(dt, t);
    return draw();
  };

  // `?still=4` simulates four seconds, draws one frame and stops. Handy for stills, and it
  // lets a headless browser capture these pages — an endless rAF loop never goes idle.
  const still = new URLSearchParams(location.search).get('still');
  if (still === null) {
    renderer.setAnimationLoop((time: number) => {
      const dt = Math.min((time - last) / 1000, 0.05);
      last = time;
      void step(dt, time / 1000);
    });
  } else {
    const seconds = Number(still) || 3;
    setTimeout(() => { // callbacks are registered after this function returns
      const dt = 1 / 60;
      for (let i = 1; i <= Math.round(seconds / dt); i++) advance(dt, i * dt);
      void draw();
    }, 0);
  }

  const stage: Stage = {
    renderer,
    scene,
    camera,
    controls,
    setEnvironment,
    onFrame: (cb) => callbacks.push(cb),
    renderOnce: async (seconds = 1) => { await step(1 / 60, seconds); },
  };
  // Debug/scripting hook, same as the main app's `window.__app`.
  (window as unknown as { __stage: Stage }).__stage = stage;
  return stage;
}

/** Renders the fatal-error card the demos share when the renderer can't start. */
export function fatal(err: unknown): void {
  const el = document.createElement('div');
  el.className = 'fatal';
  el.textContent =
    `Couldn't start the renderer: ${(err as Error)?.message ?? err}. ` +
    'These demos need WebGPU or WebGL2 — try a recent Chrome, Edge or Firefox.';
  document.body.appendChild(el);
  console.error(err);
}

// ---------- studio environment ----------

export interface EnvPanel {
  id: string;
  label: string;
  color: number;
  intensity: number;
  size: [number, number];
  pos: [number, number, number];
}

/**
 * The light panels the main app prefilters into its environment map. Crystals and the
 * lacquered sphere are mostly REFLECTION, so this list — not the light rig — decides what
 * the highlights look like. The `studio` demo toggles them one at a time.
 */
export const ENV_PANELS: readonly EnvPanel[] = [
  { id: 'softbox', label: 'Overhead softbox', color: 0xfff6ea, intensity: 9, size: [4.5, 3], pos: [1.5, 8, 2] },
  { id: 'topback', label: 'Hard top-back strip', color: 0xffffff, intensity: 22, size: [0.7, 4.5], pos: [-2.5, 5, -6] },
  { id: 'cool', label: 'Cool strip (left)', color: 0x9db8ff, intensity: 5, size: [1.2, 7], pos: [-7, 2, -2] },
  { id: 'warm', label: 'Warm strip (right)', color: 0xffd9b0, intensity: 3.5, size: [1.6, 5], pos: [6, 1.5, 3] },
  { id: 'violet', label: 'Violet back wash', color: 0x8a5cff, intensity: 4, size: [6, 3.5], pos: [0, 2.5, -8] },
  { id: 'floor', label: 'Floor bounce', color: 0x2e3c58, intensity: 1.2, size: [9, 9], pos: [0, -5, 0] },
];

/** Builds the little room of emissive quads that becomes the environment map. */
export function buildEnvironmentScene(panels: readonly EnvPanel[]): THREE.Scene {
  const env = new THREE.Scene();
  const geo = new THREE.PlaneGeometry(1, 1);
  for (const p of panels) {
    const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    // HDR: colors above 1 stop being surfaces and start being light sources.
    mat.color.set(p.color).multiplyScalar(p.intensity);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.set(p.size[0], p.size[1], 1);
    mesh.position.set(...p.pos);
    mesh.lookAt(0, 0, 0);
    mesh.userData.panelId = p.id;
    env.add(mesh);
  }
  return env;
}

export function buildEnvironmentTexture(
  renderer: THREE.WebGPURenderer,
  panels: readonly EnvPanel[],
): THREE.Texture {
  const env = buildEnvironmentScene(panels);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(env, 0.04).texture;
  pmrem.dispose();
  return texture;
}

/** The app's canvas: a satin basalt sphere, matte enough to let painted geometry star. */
export function canvasSphere(radius = 1, segments = 96): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, segments, Math.round(segments * 0.66)),
    new THREE.MeshPhysicalMaterial({
      color: 0x1b1d24,
      metalness: 0.05,
      roughness: 0.52,
      clearcoat: 0.35,
      clearcoatRoughness: 0.3,
      envMapIntensity: 0.55,
    }),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** A compact version of the app's three-point rig, for demos that need real shading. */
export function studioLights(parent: THREE.Object3D): void {
  const key = new THREE.SpotLight(0xfff2e2, 60, 0, Math.PI / 5, 0.55, 1.8);
  key.position.set(3.4, 5.6, 2.6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 5;

  const back = new THREE.DirectionalLight(0xa9b8ff, 2.4);
  back.position.set(-3, 3.2, -4.5);
  const kick = new THREE.DirectionalLight(0xcaa6ff, 1.2);
  kick.position.set(4.5, 1.2, -3);
  const hemi = new THREE.HemisphereLight(0x8ea0c8, 0x0c0a14, 0.18);

  parent.add(key, key.target, back, kick, hemi);
}

// ---------- the scripted hand ----------

export interface ArcOptions {
  radius?: number;
  /** Direction of the first sample (normalised internally). */
  from: THREE.Vector3;
  to: THREE.Vector3;
  count?: number;
  /** Lateral wobble in radians — a hand-drawn stroke is never a great circle. */
  wobble?: number;
  wobbleFreq?: number;
  /**
   * Bunches samples where the "hand" slowed down. Pointer events arrive at a fixed rate,
   * not a fixed distance, so real strokes are dense in the corners and sparse in the sweep.
   */
  uneven?: boolean;
}

/** A believable painted stroke across a sphere, in anchor-local space. */
export function arcSamples(options: ArcOptions): SurfaceSample[] {
  const radius = options.radius ?? 1;
  const count = options.count ?? 60;
  const wobble = options.wobble ?? 0.06;
  const freq = options.wobbleFreq ?? 1.6;

  const a = options.from.clone().normalize();
  const b = options.to.clone().normalize();
  const axis = new THREE.Vector3().crossVectors(a, b).normalize();
  const angle = a.angleTo(b);

  const samples: SurfaceSample[] = [];
  for (let i = 0; i < count; i++) {
    let t = i / (count - 1);
    // Ease in and out so the middle of the stroke is fast and the ends linger.
    if (options.uneven) t = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const dir = a.clone().applyAxisAngle(axis, angle * t);
    const tangent = new THREE.Vector3().crossVectors(axis, dir).normalize();
    dir.applyAxisAngle(tangent, Math.sin(t * freq * Math.PI * 2) * wobble);
    const position = dir.clone().multiplyScalar(radius);
    samples.push({
      position,
      normal: dir.clone(),
      local: position.clone(),
      localNormal: dir.clone(),
    });
  }
  return samples;
}

/**
 * A looping playhead: rises 0 → 1 over `draw` seconds, holds, then snaps back.
 * Every demo that replays a stroke shares this so the GIFs cut cleanly.
 */
export class Replayer {
  time = 0;
  constructor(
    private draw: number,
    private hold: number,
    private onReset: () => void,
  ) {}

  /** Returns the current progress, 0..1. */
  advance(dt: number): number {
    this.time += dt;
    if (this.time > this.draw + this.hold) {
      this.time = 0;
      this.onReset();
    }
    return Math.min(this.time / this.draw, 1);
  }

  restart(): void {
    this.time = 0;
    this.onReset();
  }
}

// ---------- control panel ----------

export interface SliderOptions {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}

export interface CheckOptions {
  label: string;
  value?: boolean;
  onChange: (v: boolean) => void;
}

export class Panel {
  readonly el = document.createElement('div');

  constructor(title = 'Controls') {
    this.el.className = 'panel';
    const h = document.createElement('h2');
    h.textContent = title;
    this.el.appendChild(h);
    document.body.appendChild(this.el);
  }

  private row(): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'row';
    this.el.appendChild(row);
    return row;
  }

  slider(options: SliderOptions): (v: number) => void {
    const row = this.row();
    const format = options.format ?? ((v: number) => v.toFixed(2));
    const label = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = options.label;
    const val = document.createElement('span');
    val.className = 'val';
    val.textContent = format(options.value);
    label.append(name, val);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(options.min);
    input.max = String(options.max);
    input.step = String(options.step ?? (options.max - options.min) / 200);
    input.value = String(options.value);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      val.textContent = format(v);
      options.onChange(v);
    });

    row.append(label, input);
    return (v: number) => {
      input.value = String(v);
      val.textContent = format(v);
      options.onChange(v);
    };
  }

  check(options: CheckOptions): (v: boolean) => void {
    const row = this.row();
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = options.value ?? false;
    const box = document.createElement('span');
    box.className = 'box';
    const text = document.createElement('span');
    text.textContent = options.label;
    label.append(input, box, text);
    input.addEventListener('change', () => options.onChange(input.checked));
    row.append(label);
    return (v: boolean) => {
      input.checked = v;
      options.onChange(v);
    };
  }

  button(label: string, onClick: () => void, ghost = false): void {
    const row = this.row();
    const btn = document.createElement('button');
    if (ghost) btn.className = 'ghost';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    row.append(btn);
  }

  note(html: string): void {
    const p = document.createElement('p');
    p.className = 'note';
    p.innerHTML = html;
    this.el.appendChild(p);
  }
}

// ---------- readouts ----------

export type Tone = 'plain' | 'hi' | 'good' | 'bad';

export class Readouts {
  private el = document.createElement('div');

  constructor() {
    this.el.className = 'readouts';
    document.body.appendChild(this.el);
  }

  add(label: string, initial = '—', tone: Tone = 'plain'): (v: string, tone?: Tone) => void {
    const row = document.createElement('div');
    row.className = tone === 'plain' ? 'r' : `r ${tone}`;
    const name = document.createElement('span');
    name.textContent = label;
    const value = document.createElement('span');
    value.textContent = initial;
    row.append(name, value);
    this.el.appendChild(row);
    return (v: string, newTone?: Tone) => {
      value.textContent = v;
      if (newTone) row.className = newTone === 'plain' ? 'r' : `r ${newTone}`;
    };
  }
}

// ---------- small helpers ----------

/** Unlit, always-visible line — for normals, tangents, frames and other debug overlays. */
export function debugLine(color: number, points: THREE.Vector3[]): THREE.Line {
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const mat = new THREE.LineBasicMaterial({ color, depthTest: false, toneMapped: false, transparent: true });
  const line = new THREE.Line(geo, mat);
  line.renderOrder = 20;
  line.frustumCulled = false;
  return line;
}

/** A cone tip so a debug line reads as an arrow at GIF resolution. */
export function debugArrow(color: number, length: number): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, toneMapped: false });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, length, 8), mat);
  shaft.position.y = length / 2;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.09, 12), mat);
  head.position.y = length;
  group.add(shaft, head);
  group.renderOrder = 20;
  group.traverse((o) => { o.renderOrder = 20; });
  return group;
}

/** Points the +Y of an object along `dir`. */
export function orientY(object: THREE.Object3D, dir: THREE.Vector3): void {
  object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
}

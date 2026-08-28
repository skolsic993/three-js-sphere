import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  abs, attribute, cos, float, mix, positionLocal, smoothstep, time, uniform, vec3,
} from 'three/tsl';
import { mulberry32, type PaintMode, type StrokeInstance, type SurfaceSample } from './mode';

/**
 * Aurora silk mode. A stroke unfurls a curtain of luminous silk from the surface — a tall
 * waving sheet of light in the spirit of an aurora borealis, rendered as pure shader:
 *
 *  - CURTAIN ×2 — one grid geometry drawn twice (front + a shorter back layer with its own
 *    phase), displaced in the vertex stage by layered sine waves whose amplitude grows
 *    with height, so the hem stays pinned to the stroke while the top billows.
 *  - FOLD LIGHT — the fragment brightness is locked to the *same phase* as the vertex
 *    wave, so the curtain glows brightest along its folds, exactly like translucent
 *    fabric seen edge-on. The folds therefore visibly travel with the cloth.
 *  - RAYS — thin vertical striations drifting slowly along the curtain (the aurora
 *    "curtain of rays" look), plus a bright hem at the bottom edge.
 *  - HEM GLOW — an additive strip laid on the surface, tinting the sphere beneath.
 *  - MOTES — twinkling star-dust drifting inside the curtain volume.
 *  - LIGHT SPILL — cool point lights breathing softly along the stroke.
 *
 * Palettes are color UNIFORMS (switching retints everything live), 'Spectrum' swaps in a
 * cosine color-cycling palette. Height, wave, flow, rays, brightness: all uniforms. The
 * curtain unfurls along the stroke as the growth front passes.
 */

export type AuroraPaletteName = 'Borealis' | 'Twilight' | 'Ember' | 'Spectrum';

export interface AuroraSettings {
  palette: AuroraPaletteName;
  height: number;      // curtain height (world units)
  wave: number;        // billow amplitude
  flow: number;        // animation speed
  rays: number;        // vertical striation strength
  brightness: number;  // overall curtain intensity
  sparkles: number;    // motes inside the curtain (live-culled up to MAX_MOTES)
  lightSpill: number;  // breathing point-light intensity
  growthSpeed: number; // unfurl speed (world units / second)
}

export const defaultAuroraSettings: AuroraSettings = {
  palette: 'Borealis',
  height: 0.62,
  wave: 0.55,
  flow: 1,
  rays: 0.7,
  brightness: 1,
  sparkles: 140,
  lightSpill: 0.8,
  growthSpeed: 1.2,
};

export const MAX_MOTES = 240;

interface AuroraPalette {
  hem: THREE.Color; // bottom edge (the intense border)
  mid: THREE.Color;
  top: THREE.Color; // fades out at the crest
}

const PALETTES: Record<Exclude<AuroraPaletteName, 'Spectrum'>, AuroraPalette> = {
  Borealis: { hem: new THREE.Color(0x3cffa8), mid: new THREE.Color(0x36c9ff), top: new THREE.Color(0xb26bff) },
  Twilight: { hem: new THREE.Color(0xff8ac2), mid: new THREE.Color(0xa06bff), top: new THREE.Color(0x3d2bd6) },
  Ember: { hem: new THREE.Color(0xffc46a), mid: new THREE.Color(0xff6a8a), top: new THREE.Color(0x8a3dff) },
};

const PATH_STEP = 0.03;
const HEIGHT_SEGS = 14;

/* eslint-disable @typescript-eslint/no-explicit-any */
// @types/three loses node types on attribute() and color uniforms — rewrap via converts.
const attrFloat = (name: string) => float(attribute(name, 'float') as any);
const attrVec3 = (name: string) => vec3(attribute(name, 'vec3') as any);
const colorVec = (u: unknown) => vec3(u as any);
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------- shared sprite ----------

let moteTexture: THREE.CanvasTexture | null = null;

function getMoteTexture(): THREE.CanvasTexture {
  if (!moteTexture) {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.3, 'rgba(220,235,255,0.7)');
    g.addColorStop(1, 'rgba(160,190,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    moteTexture = new THREE.CanvasTexture(canvas);
  }
  return moteTexture;
}

let moteMaterial: THREE.MeshBasicMaterial | null = null;

function getMoteMaterial(): THREE.MeshBasicMaterial {
  if (!moteMaterial) {
    moteMaterial = new THREE.MeshBasicMaterial({
      map: getMoteTexture(),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
  }
  return moteMaterial;
}

// ---------- path ----------

interface PathPoint {
  pos: THREE.Vector3;
  normal: THREE.Vector3; // "up" for the curtain — radially off the surface
  side: THREE.Vector3;
  dist: number;
}

function buildPath(samples: SurfaceSample[]): PathPoint[] {
  const pts: PathPoint[] = [];
  let travelled = 0;
  let next = 0;
  const tangent = new THREE.Vector3();
  for (let i = 0; i < samples.length; i++) {
    if (i > 0) travelled += samples[i].local.distanceTo(samples[i - 1].local);
    if (travelled < next && i !== samples.length - 1) continue;
    next = travelled + PATH_STEP;
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

/** Curtain grid: columns along the stroke × rows up the curtain. All vertices sit at the
 *  HEM (the lift happens in the vertex shader), so height/wave/unfurl are pure uniforms. */
function buildCurtainGeometry(path: PathPoint[], rnd: () => number): THREE.BufferGeometry {
  const cols = path.length;
  const rows = HEIGHT_SEGS + 1;
  const positions = new Float32Array(cols * rows * 3);
  const ups = new Float32Array(cols * rows * 3);
  const sides = new Float32Array(cols * rows * 3);
  const dists = new Float32Array(cols * rows);
  const vs = new Float32Array(cols * rows);
  const colJits = new Float32Array(cols * rows);
  const indices: number[] = [];

  let jit = 1;
  for (let i = 0; i < cols; i++) {
    const p = path[i];
    // Smooth random walk → an organic, uneven curtain crest.
    jit = THREE.MathUtils.clamp(jit + (rnd() - 0.5) * 0.22, 0.68, 1.32);
    for (let r = 0; r < rows; r++) {
      const vi = i * rows + r;
      positions[vi * 3] = p.pos.x;
      positions[vi * 3 + 1] = p.pos.y;
      positions[vi * 3 + 2] = p.pos.z;
      ups[vi * 3] = p.normal.x;
      ups[vi * 3 + 1] = p.normal.y;
      ups[vi * 3 + 2] = p.normal.z;
      sides[vi * 3] = p.side.x;
      sides[vi * 3 + 1] = p.side.y;
      sides[vi * 3 + 2] = p.side.z;
      dists[vi] = p.dist;
      vs[vi] = r / HEIGHT_SEGS;
      colJits[vi] = jit;
    }
  }
  for (let i = 0; i < cols - 1; i++) {
    for (let r = 0; r < rows - 1; r++) {
      const a = i * rows + r;
      const b = (i + 1) * rows + r;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aUp', new THREE.BufferAttribute(ups, 3));
  geo.setAttribute('aSide', new THREE.BufferAttribute(sides, 3));
  geo.setAttribute('aDist', new THREE.BufferAttribute(dists, 1));
  geo.setAttribute('aV', new THREE.BufferAttribute(vs, 1));
  geo.setAttribute('aColJit', new THREE.BufferAttribute(colJits, 1));
  geo.setIndex(indices);
  return geo;
}

/** Two-row strip on the surface for the hem glow (across displacement in the shader). */
function buildHemGeometry(path: PathPoint[]): THREE.BufferGeometry {
  const n = path.length;
  const positions = new Float32Array(n * 2 * 3);
  const sides = new Float32Array(n * 2 * 3);
  const across = new Float32Array(n * 2);
  const dists = new Float32Array(n * 2);
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = path[i];
    for (let k = 0; k < 2; k++) {
      const vi = i * 2 + k;
      positions[vi * 3] = p.pos.x + p.normal.x * 0.005;
      positions[vi * 3 + 1] = p.pos.y + p.normal.y * 0.005;
      positions[vi * 3 + 2] = p.pos.z + p.normal.z * 0.005;
      sides[vi * 3] = p.side.x;
      sides[vi * 3 + 1] = p.side.y;
      sides[vi * 3 + 2] = p.side.z;
      across[vi] = k === 0 ? -1 : 1;
      dists[vi] = p.dist;
    }
  }
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aSide', new THREE.BufferAttribute(sides, 3));
  geo.setAttribute('aAcross', new THREE.BufferAttribute(across, 1));
  geo.setAttribute('aDist', new THREE.BufferAttribute(dists, 1));
  geo.setIndex(indices);
  return geo;
}

// ---------- motes ----------

interface Mote {
  base: THREE.Vector3; // rest position inside the curtain
  up: THREE.Vector3;
  side: THREE.Vector3;
  v: number;           // height fraction (drifts with the wave amplitude)
  dist: number;
  size: number;
  phase: number;
  twinkle: number;     // twinkle rate
  colorMix: number;    // 0..1 blend across the palette
  quat: THREE.Quaternion;
}

const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _color = new THREE.Color();
const _cA = new THREE.Color();
const _cB = new THREE.Color();

// ---------- the stroke ----------

class AuroraStroke implements StrokeInstance {
  readonly group = new THREE.Group();

  private settings: AuroraSettings;
  private path: PathPoint[];
  private readonly total: number;
  private grown = 0;

  // live uniforms
  private uGrown = uniform(0);
  private uTotal = uniform(1);
  private uHeight = uniform(0.6);
  private uWave = uniform(0.5);
  private uFlow = uniform(1);
  private uRays = uniform(0.7);
  private uBright = uniform(1);
  private uSpectrum = uniform(0);
  private uHem = uniform(new THREE.Color());
  private uMid = uniform(new THREE.Color());
  private uTop = uniform(new THREE.Color());

  private curtainGeo!: THREE.BufferGeometry;
  private hemGeo!: THREE.BufferGeometry;
  private materials: MeshBasicNodeMaterial[] = [];

  private motes: Mote[] = [];
  private moteMesh: THREE.InstancedMesh;

  private lights: { light: THREE.PointLight; dist: number; phase: number; warm: boolean }[] = [];

  constructor(samples: SurfaceSample[], seed: number, settings: AuroraSettings) {
    this.settings = { ...settings };
    const rnd = mulberry32(seed);
    this.path = buildPath(samples);
    this.total = this.path.length ? this.path[this.path.length - 1].dist : 0;
    this.uTotal.value = Math.max(this.total, 1e-3);

    // ----- curtains: one geometry, two layers with their own phase and stature -----
    this.curtainGeo = buildCurtainGeometry(this.path, rnd);
    const front = this.makeCurtainMaterial(0, 1, 1);
    const back = this.makeCurtainMaterial(2.4, 0.72, 0.55);
    const frontMesh = new THREE.Mesh(this.curtainGeo, front);
    const backMesh = new THREE.Mesh(this.curtainGeo, back);
    for (const m of [backMesh, frontMesh]) {
      m.renderOrder = 2;
      m.frustumCulled = false;
      this.group.add(m);
    }

    // ----- hem glow -----
    this.hemGeo = buildHemGeometry(this.path);
    const hemMat = this.makeHemMaterial();
    const hemMesh = new THREE.Mesh(this.hemGeo, hemMat);
    hemMesh.renderOrder = 1;
    hemMesh.frustumCulled = false;
    this.group.add(hemMesh);

    // ----- motes -----
    for (let i = 0; i < MAX_MOTES; i++) {
      const p = this.path[Math.floor(rnd() * this.path.length)];
      const v = Math.pow(rnd(), 1.4); // cluster toward the hem
      this.motes.push({
        base: p.pos.clone(),
        up: p.normal,
        side: p.side,
        v,
        dist: p.dist,
        size: 0.008 + rnd() * 0.016,
        phase: rnd() * Math.PI * 2,
        twinkle: 0.6 + rnd() * 2.2,
        colorMix: rnd(),
        quat: new THREE.Quaternion().setFromEuler(
          new THREE.Euler(rnd() * Math.PI, rnd() * Math.PI, rnd() * Math.PI),
        ),
      });
    }
    this.moteMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), getMoteMaterial(), MAX_MOTES);
    for (let i = 0; i < MAX_MOTES; i++) {
      this.moteMesh.setMatrixAt(i, _zero);
      this.moteMesh.setColorAt(i, _color.setRGB(0, 0, 0));
    }
    this.moteMesh.renderOrder = 3;
    this.moteMesh.frustumCulled = false;
    this.group.add(this.moteMesh);

    // ----- light spill: cool lights breathing along the stroke -----
    const nLights = Math.min(3, Math.max(1, Math.round(this.total * 1.2)));
    for (let i = 0; i < nLights; i++) {
      const f = nLights === 1 ? 0.5 : 0.15 + (0.7 * i) / (nLights - 1);
      const p = this.pathAt(this.total * f);
      const light = new THREE.PointLight(0xffffff, 0, 1.6, 2);
      light.position.copy(p.pos).addScaledVector(p.normal, 0.16);
      this.group.add(light);
      this.lights.push({ light, dist: this.total * f, phase: rnd() * 20, warm: i % 2 === 1 });
    }

    this.applySettings(settings);
  }

  /**
   * The curtain shader. `phase` de-synchronizes the back layer; `stature`/`dim` shrink
   * and soften it so the two sheets read as separate bands of one aurora.
   */
  private makeCurtainMaterial(phase: number, stature: number, dim: number): MeshBasicNodeMaterial {
    const mat = new MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;
    mat.blending = THREE.AdditiveBlending;
    this.materials.push(mat);

    const aUp = attrVec3('aUp');
    const aSide = attrVec3('aSide');
    const aDist = attrFloat('aDist');
    const aV = attrFloat('aV');
    const aColJit = attrFloat('aColJit');
    const T = time.mul(this.uFlow);

    // Unfurl: the curtain lifts out of the surface as the growth front sweeps past.
    const unfurl = smoothstep(0.0, 0.4, this.uGrown.sub(aDist));
    const lift = this.uHeight.mul(aColJit).mul(aV).mul(unfurl).mul(stature);

    // Billow: two traveling waves + a fine ripple; amplitude grows with height so the
    // hem stays pinned. A slow global breath keeps the whole sheet alive.
    const breath = T.mul(0.23).add(phase).sin().mul(0.2).add(0.8);
    const amp = this.uWave.mul(0.17).mul(aV.pow(1.35)).mul(unfurl).mul(breath);
    const foldPhase = aDist.mul(6.3).add(T.mul(1.1)).add(phase);
    const sway = foldPhase.sin()
      .add(aDist.mul(11.7).sub(T.mul(0.7)).add(aV.mul(1.8)).add(phase).sin().mul(0.5));
    const ripple = aDist.mul(23).add(T.mul(1.9)).add(aV.mul(4)).add(phase).sin().mul(0.02).mul(aV);

    mat.positionNode = positionLocal
      .add(aUp.mul(lift.add(ripple.mul(0.4))))
      .add(aSide.mul(amp.mul(sway).add(ripple)));

    // ----- fragment -----
    // Fold light: same phase as the sway → the curtain glows along its moving folds.
    const folds = abs(cos(foldPhase)).pow(1.6).mul(0.85).add(0.4);
    // Vertical rays drifting slowly along the stroke.
    const rayWave = aDist.mul(36).add(T.mul(0.45).sin().mul(1.6)).add(aV.mul(2.2)).sin().mul(0.5).add(0.5);
    const rays = mix(float(1), rayWave.pow(2.4).mul(1.7).add(0.25), this.uRays);
    // Intense lower border, like the real thing.
    const hemBoost = smoothstep(0.0, 0.22, aV).oneMinus().mul(1.3).add(1);

    // Palette gradient hem → mid → top, or the cosine spectrum that cycles along the stroke.
    let grad = mix(colorVec(this.uHem), colorVec(this.uMid), smoothstep(0.03, 0.45, aV));
    grad = mix(grad, colorVec(this.uTop), smoothstep(0.45, 0.95, aV));
    const spec = cos(
      vec3(aDist.mul(0.9).add(T.mul(0.1)), aDist.mul(0.9).add(T.mul(0.1)).add(2.09), aDist.mul(0.9).add(T.mul(0.1)).add(4.18)),
    ).mul(0.5).add(0.5).mul(vec3(0.9, 1.0, 1.2));
    const color = mix(grad, spec, this.uSpectrum);

    mat.colorNode = color.mul(folds).mul(rays).mul(hemBoost).mul(this.uBright).mul(1.3 * dim);

    // Feathered crest and soft ends; the sheet fades with height.
    const endFade = smoothstep(0.0, 0.22, aDist.min(this.uTotal.sub(aDist)));
    const feather = aDist.mul(17).add(aV.mul(9)).add(T.mul(0.8)).sin().mul(0.12).add(0.88);
    mat.opacityNode = float(1).sub(aV).pow(1.15).mul(unfurl).mul(endFade).mul(feather).mul(0.85);
    return mat;
  }

  /** Soft additive pool of light where the silk meets the surface. */
  private makeHemMaterial(): MeshBasicNodeMaterial {
    const mat = new MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.blending = THREE.AdditiveBlending;
    this.materials.push(mat);

    const aSide = attrVec3('aSide');
    const aAcross = attrFloat('aAcross');
    const aDist = attrFloat('aDist');
    const T = time.mul(this.uFlow);

    mat.positionNode = positionLocal.add(aSide.mul(aAcross.mul(this.uHeight.mul(0.22).add(0.05))));

    const unfurl = smoothstep(0.0, 0.3, this.uGrown.sub(aDist));
    const endFade = smoothstep(0.0, 0.2, aDist.min(this.uTotal.sub(aDist)));
    const falloff = abs(aAcross).oneMinus().max(0).pow(1.5);
    const shimmer = aDist.mul(6.3).add(T.mul(1.1)).cos().mul(0.2).add(0.8);
    const color = mix(colorVec(this.uHem), colorVec(this.uMid), 0.35);
    mat.colorNode = color.mul(falloff).mul(shimmer).mul(this.uBright).mul(0.5);
    mat.opacityNode = unfurl.mul(endFade);
    return mat;
  }

  // ----- live settings -----

  applySettings(settings: unknown): void {
    const s = settings as AuroraSettings;
    this.settings = { ...s };
    this.uHeight.value = s.height;
    this.uWave.value = s.wave;
    this.uFlow.value = s.flow;
    this.uRays.value = s.rays;
    this.uBright.value = s.brightness;
    this.uSpectrum.value = s.palette === 'Spectrum' ? 1 : 0;
    const pal = PALETTES[s.palette === 'Spectrum' ? 'Borealis' : s.palette];
    (this.uHem.value as THREE.Color).copy(pal.hem);
    (this.uMid.value as THREE.Color).copy(pal.mid);
    (this.uTop.value as THREE.Color).copy(pal.top);
  }

  // ----- StrokeInstance -----

  update(dt: number, t: number): void {
    if (this.grown < this.total + 1) {
      this.grown += dt * this.settings.growthSpeed;
      this.uGrown.value = this.grown;
    }
    this.updateMotes(t);
    this.updateLights(t);
  }

  finishGrowth(): void {
    this.grown = this.total + 2;
    this.uGrown.value = this.grown;
  }

  private pathAt(dist: number): PathPoint {
    const i = THREE.MathUtils.clamp(Math.round(dist / PATH_STEP), 0, this.path.length - 1);
    return this.path[i];
  }

  private updateMotes(t: number): void {
    const s = this.settings;
    const flow = t * s.flow;
    const pal = PALETTES[s.palette === 'Spectrum' ? 'Borealis' : s.palette];
    _cA.copy(pal.hem);
    _cB.copy(pal.top);
    const open = this.grown;
    for (let i = 0; i < this.motes.length; i++) {
      const m = this.motes[i];
      if (i >= s.sparkles || m.dist > open) {
        this.moteMesh.setMatrixAt(i, _zero);
        continue;
      }
      // Drift with (a simplification of) the curtain's own wave, so motes ride the silk.
      const lift = s.height * m.v * (0.35 + 0.65 * Math.min((open - m.dist) / 0.4, 1));
      const sway = Math.sin(m.dist * 6.3 + flow * 1.1) * s.wave * 0.17 * Math.pow(m.v, 1.35);
      const bob = Math.sin(flow * 0.6 + m.phase) * 0.02;
      _p.copy(m.base)
        .addScaledVector(m.up, lift + bob)
        .addScaledVector(m.side, sway + Math.sin(flow * 0.4 + m.phase * 1.7) * 0.02);
      const tw = Math.pow(0.5 + 0.5 * Math.sin(flow * m.twinkle * 2 + m.phase), 2.5);
      _s.setScalar(m.size * (0.7 + tw * 0.6));
      _m.compose(_p, m.quat, _s);
      this.moteMesh.setMatrixAt(i, _m);
      _color.copy(_cA).lerp(_cB, m.colorMix).multiplyScalar((0.25 + tw * 1.3) * s.brightness);
      this.moteMesh.setColorAt(i, _color);
    }
    this.moteMesh.instanceMatrix.needsUpdate = true;
    if (this.moteMesh.instanceColor) this.moteMesh.instanceColor.needsUpdate = true;
  }

  private updateLights(t: number): void {
    const pal = PALETTES[this.settings.palette === 'Spectrum' ? 'Borealis' : this.settings.palette];
    for (const { light, dist, phase, warm } of this.lights) {
      if (this.grown <= dist) {
        light.intensity = 0;
        continue;
      }
      const ignite = THREE.MathUtils.clamp((this.grown - dist) / 0.5, 0, 1);
      const breathe = 0.72 + 0.28 * Math.sin(t * 0.9 * this.settings.flow + phase);
      light.color.copy(warm ? pal.top : pal.hem);
      light.intensity = this.settings.lightSpill * 1.1 * ignite * breathe;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.curtainGeo.dispose();
    this.hemGeo.dispose();
    for (const m of this.materials) m.dispose();
    this.moteMesh.geometry.dispose();
    this.moteMesh.dispose(); // material + sprite are shared
  }
}

// ---------- the mode ----------

export const auroraMode: PaintMode<AuroraSettings> = {
  id: 'Aurora silk',
  createStroke(samples, seed, settings): StrokeInstance {
    return new AuroraStroke(samples, seed, settings);
  },
};

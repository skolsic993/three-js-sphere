import * as THREE from 'three';
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import {
  float, hash, instanceIndex, mix, positionLocal, positionWorld, texture, time, uniform, vec3,
} from 'three/tsl';
import { mulberry32, type PaintMode, type StrokeInstance, type SurfaceSample } from './mode';

/**
 * Bioluminescent reef mode. A stroke seeds a living deep-sea colony along the painted
 * path — and then the colony BREATHES:
 *
 *  - CORAL TREES  — recursively branched staghorn colonies built from instanced knobbly
 *    tapered segments. Dark bodies, so the light show owns the frame.
 *  - POLYP TIPS   — a glowing bud at every branch end. Their brightness rides a traveling
 *    pulse wave computed from WORLD position, so bioluminescence ripples across the whole
 *    reef — even across separate strokes — like a signal passing through one organism.
 *    Each polyp also blinks slightly off-phase (hash(instanceIndex)).
 *  - ANEMONES     — clusters of thin tendrils bending in a procedural current (vertex
 *    sway, zero CPU), glow gradients running to their tips on the same colony pulse.
 *  - SEA FANS     — canvas-drawn gorgonian lattices with glowing veins, swaying slowly.
 *  - PLANKTON     — a drifting field of twinkling sparkles around the colony.
 *  - LIGHT SPILL  — teal point lights breathing with slow tides.
 *
 * Live controls follow the house rules: glow/pulse/sway are global shader uniforms;
 * branching depth, density, tendrils and plankton cull generated-at-max instances;
 * colony size re-poses matrices in place. Nothing rebuilds while you drag.
 */

export type ReefPaletteName = 'Abyss' | 'Tropic' | 'Ghost' | 'Toxic';

export interface ReefSettings {
  palette: ReefPaletteName;
  colonySize: number;  // coral tree scale (world units)
  density: number;     // colony clusters per world unit (live-culled up to MAX_DENSITY)
  branching: number;   // 0..1 — how many branch generations survive (live depth cull)
  tendrils: number;    // anemone tendrils per cluster (live-culled up to MAX_TENDRILS)
  glow: number;        // bioluminescence intensity
  pulseSpeed: number;  // traveling colony-pulse speed
  sway: number;        // water current
  plankton: number;    // drifting sparkles (live-culled up to MAX_PLANKTON)
  lightSpill: number;
  growthSpeed: number; // colony sprout speed (world units / second)
}

export const defaultReefSettings: ReefSettings = {
  palette: 'Abyss',
  colonySize: 0.19,
  density: 10,
  branching: 0.85,
  tendrils: 9,
  glow: 1.2,
  pulseSpeed: 1,
  sway: 0.5,
  plankton: 150,
  lightSpill: 1,
  growthSpeed: 1.1,
};

export const MAX_DENSITY = 14;
export const MAX_TENDRILS = 14;
export const MAX_PLANKTON = 220;
const MAX_DEPTH = 3; // branch generations generated; the slider culls them live

interface ReefPalette {
  bodyA: THREE.Color; // coral flesh (dark)
  bodyB: THREE.Color;
  glowA: THREE.Color; // polyp light
  glowB: THREE.Color;
}

const PALETTES: Record<ReefPaletteName, ReefPalette> = {
  Abyss: {
    bodyA: new THREE.Color(0x241a3e),
    bodyB: new THREE.Color(0x3a1f4e),
    glowA: new THREE.Color(0x2ee6d6),
    glowB: new THREE.Color(0x4e8aff),
  },
  Tropic: {
    bodyA: new THREE.Color(0x4e1230),
    bodyB: new THREE.Color(0x6e1a2a),
    glowA: new THREE.Color(0x33ffa8),
    glowB: new THREE.Color(0xff5ea8),
  },
  Ghost: {
    bodyA: new THREE.Color(0x2a3140),
    bodyB: new THREE.Color(0x3a4456),
    glowA: new THREE.Color(0xbfe8ff),
    glowB: new THREE.Color(0x7fb0ff),
  },
  Toxic: {
    bodyA: new THREE.Color(0x14301a),
    bodyB: new THREE.Color(0x1f4020),
    glowA: new THREE.Color(0x8aff2e),
    glowB: new THREE.Color(0xe6ff4e),
  },
};

// ---------- global (mode-wide) uniforms ----------

const uGlow = uniform(1);
const uPulse = uniform(1);
const uSway = uniform(0.5);
const uGlowA = uniform(new THREE.Color(0x2ee6d6));
const uGlowB = uniform(new THREE.Color(0x4e8aff));

/* eslint-disable @typescript-eslint/no-explicit-any */
const colorVec = (u: unknown) => vec3(u as any);
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Live style setter — palette/glow/pulse/sway are shared by every reef stroke. */
export function setReefStyle(s: ReefSettings): void {
  uGlow.value = s.glow;
  uPulse.value = s.pulseSpeed;
  uSway.value = s.sway;
  const p = PALETTES[s.palette];
  (uGlowA.value as THREE.Color).copy(p.glowA);
  (uGlowB.value as THREE.Color).copy(p.glowB);
}

/** The colony heartbeat: a light wave traveling through world space, shared by polyps,
 *  tendril tips and fan veins so the whole reef pulses as one organism. */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- inferred TSL node types
function colonyPulse() {
  return positionWorld.dot(vec3(1.6, 1.1, 1.35)).mul(2.6)
    .sub(time.mul(uPulse.mul(2.1)))
    .sin().mul(0.5).add(0.5).pow(2.5);
}

// ---------- shared geometries ----------

let coralGeo: THREE.BufferGeometry | null = null;

/** One knobbly tapered branch segment, base at y=0, unit length. */
function getCoralGeometry(): THREE.BufferGeometry {
  if (!coralGeo) {
    const rnd = mulberry32(0xc0a71);
    const geo = new THREE.CylinderGeometry(0.55, 1, 1, 6, 3).toNonIndexed();
    geo.translate(0, 0.5, 0);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const seen = new Map<string, [number, number, number]>();
    for (let i = 0; i < pos.count; i++) {
      const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
      let d = seen.get(key);
      if (!d) {
        d = [(rnd() - 0.5) * 0.3, (rnd() - 0.5) * 0.12, (rnd() - 0.5) * 0.3];
        seen.set(key, d);
      }
      pos.setXYZ(i, pos.getX(i) * (1 + d[0]), pos.getY(i) + d[1] * 0.3, pos.getZ(i) * (1 + d[2]));
    }
    geo.computeVertexNormals();
    coralGeo = geo;
  }
  return coralGeo;
}

let tipGeo: THREE.BufferGeometry | null = null;

function getTipGeometry(): THREE.BufferGeometry {
  if (!tipGeo) tipGeo = new THREE.IcosahedronGeometry(1, 1);
  return tipGeo;
}

let tendrilGeo: THREE.BufferGeometry | null = null;

/** A thin tapering tendril with enough height segments to bend smoothly in the shader. */
function getTendrilGeometry(): THREE.BufferGeometry {
  if (!tendrilGeo) {
    const geo = new THREE.CylinderGeometry(0.06, 1, 1, 5, 6);
    geo.translate(0, 0.5, 0);
    tendrilGeo = geo;
  }
  return tendrilGeo;
}

let fanGeo: THREE.BufferGeometry | null = null;

function getFanGeometry(): THREE.BufferGeometry {
  if (!fanGeo) {
    const geo = new THREE.PlaneGeometry(1.4, 1, 6, 6);
    geo.translate(0, 0.5, 0); // rooted at the base
    fanGeo = geo;
  }
  return fanGeo;
}

// ---------- sea-fan texture: gorgonian lattice, veins bright, membrane faint ----------

function drawFanTexture(): THREE.CanvasTexture {
  const W = 256;
  const H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const rnd = mulberry32(0x5eafa);

  // Faint membrane silhouette (a ragged fan) in low alpha.
  ctx.fillStyle = 'rgba(70,70,70,0.28)';
  ctx.beginPath();
  ctx.moveTo(128, 252);
  ctx.bezierCurveTo(20, 210, 4, 120, 30, 40);
  ctx.bezierCurveTo(80, 8, 176, 8, 226, 40);
  ctx.bezierCurveTo(252, 120, 236, 210, 128, 252);
  ctx.closePath();
  ctx.fill();

  // Branching veins: recursive forks from the root, drawn bright (they carry the glow).
  const vein = (x: number, y: number, ang: number, len: number, w: number, depth: number): void => {
    if (depth > 4 || len < 8) return;
    const nx = x + Math.cos(ang) * len;
    const ny = y - Math.sin(ang) * len;
    ctx.strokeStyle = `rgba(235,235,235,${0.95 - depth * 0.12})`;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(nx, ny);
    ctx.stroke();
    const kids = depth < 2 ? 3 : 2;
    for (let i = 0; i < kids; i++) {
      vein(nx, ny, ang + (rnd() - 0.5) * 1.1, len * (0.62 + rnd() * 0.2), Math.max(w * 0.62, 0.8), depth + 1);
    }
  };
  for (let i = 0; i < 5; i++) {
    vein(128, 252, Math.PI / 2 + (i - 2) * 0.42 + (rnd() - 0.5) * 0.2, 60 + rnd() * 26, 3.2, 0);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

// ---------- shared materials ----------

let coralMaterial: THREE.MeshStandardMaterial | null = null;

function getCoralMaterial(): THREE.MeshStandardMaterial {
  if (!coralMaterial) {
    coralMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff, // per-instance body tints
      roughness: 0.85,
      metalness: 0.05,
      envMapIntensity: 0.4,
    });
  }
  return coralMaterial;
}

let tipMaterial: MeshBasicNodeMaterial | null = null;

/** Polyp buds: HDR-bright on the pulse crest, ember-dim in the troughs → bloom does the rest. */
function getTipMaterial(): MeshBasicNodeMaterial {
  if (!tipMaterial) {
    const mat = new MeshBasicNodeMaterial();
    const blink = time.mul(0.8).add(hash(instanceIndex).mul(6.283)).sin().mul(0.15).add(0.85);
    const c = mix(colorVec(uGlowA), colorVec(uGlowB), hash(instanceIndex.add(9)));
    mat.colorNode = c.mul(colonyPulse().mul(2.6).add(0.2)).mul(blink).mul(uGlow);
    tipMaterial = mat;
  }
  return tipMaterial;
}

let tendrilMaterial: MeshStandardNodeMaterial | null = null;

/** Anemone arms: dark flesh, glow gradient to the tip, bending in the current. */
function getTendrilMaterial(): MeshStandardNodeMaterial {
  if (!tendrilMaterial) {
    const mat = new MeshStandardNodeMaterial();
    mat.roughness = 0.7;

    const w = positionLocal.y.clamp(0, 1).pow(2);
    const ph = hash(instanceIndex).mul(6.283);
    const bend = vec3(
      time.mul(0.9).add(ph).sin(),
      float(0),
      time.mul(0.7).add(ph.mul(1.6)).sin(),
    ).mul(w).mul(uSway).mul(0.35);
    mat.positionNode = positionLocal.add(bend);

    const c = mix(colorVec(uGlowA), colorVec(uGlowB), hash(instanceIndex.add(5)));
    mat.colorNode = vec3(0.06, 0.05, 0.1);
    mat.emissiveNode = c.mul(positionLocal.y.clamp(0, 1).pow(2.5))
      .mul(colonyPulse().mul(1.6).add(0.25)).mul(uGlow);
    tendrilMaterial = mat;
  }
  return tendrilMaterial;
}

let fanMaterial: MeshStandardNodeMaterial | null = null;

/** Gorgonian fans: the canvas veins glow on the colony pulse; the membrane stays dim. */
function getFanMaterial(): MeshStandardNodeMaterial {
  if (!fanMaterial) {
    const mat = new MeshStandardNodeMaterial();
    mat.side = THREE.DoubleSide;
    mat.roughness = 0.8;
    const map = texture(drawFanTexture());

    const w = positionLocal.y.clamp(0, 1).pow(1.6);
    const ph = hash(instanceIndex).mul(6.283);
    const bend = vec3(time.mul(0.55).add(ph).sin(), float(0), time.mul(0.4).add(ph.mul(1.4)).sin())
      .mul(w).mul(uSway).mul(0.16);
    mat.positionNode = positionLocal.add(bend);

    const c = mix(colorVec(uGlowA), colorVec(uGlowB), hash(instanceIndex.add(3)));
    mat.colorNode = vec3(0.07, 0.06, 0.11);
    mat.emissiveNode = c.mul(map.r).mul(colonyPulse().mul(1.4).add(0.3)).mul(uGlow).mul(0.9);
    mat.opacityNode = map.a;
    // Clip the faint membrane away — only the glowing vein lattice survives, which reads
    // as a delicate gorgonian instead of a solid sheet.
    mat.alphaTestNode = float(0.4);
    fanMaterial = mat;
  }
  return fanMaterial;
}

let planktonMaterial: THREE.MeshBasicMaterial | null = null;

function getPlanktonMaterial(): THREE.MeshBasicMaterial {
  if (!planktonMaterial) {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.3, 'rgba(210,245,255,0.7)');
    g.addColorStop(1, 'rgba(140,220,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    planktonMaterial = new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(canvas),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
  }
  return planktonMaterial;
}

// ---------- per-stroke data ----------

interface Segment {
  anchor: THREE.Vector3; // colony base on the surface (anchor space)
  pos: THREE.Vector3;    // segment base as a UNIT-space offset from the anchor
  quat: THREE.Quaternion;
  len: number;           // unit length — colonySize scales at pose time
  rad: number;
  depth: number;
  cullRnd: number;       // fractional-depth culling
  clusterRnd: number;    // density culling (whole cluster)
  birth: number;
  bodyMix: number;
  visible: boolean;
}

interface Tip {
  segIndex: number;     // follows its segment's visibility
  offset: THREE.Vector3; // unit offset from segment base (scaled by colonySize at pose)
  size: number;         // relative
  birth: number;
}

interface Tendril {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  len: number;
  rank: number;         // tendril-count culling within its anemone
  clusterRnd: number;
  birth: number;
  visible: boolean;
}

interface Fan {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  size: number;
  clusterRnd: number;
  birth: number;
  visible: boolean;
}

interface Plankter {
  center: THREE.Vector3;
  up: THREE.Vector3;
  side: THREE.Vector3;
  radius: number;
  height: number;
  speed: number;
  phase: number;
  size: number;
  colorMix: number;
  dist: number;
  quat: THREE.Quaternion;
}

const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _dir = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _color = new THREE.Color();
const _cA = new THREE.Color();
const _cB = new THREE.Color();
const _Y = new THREE.Vector3(0, 1, 0);

function easeOutBack(t: number): number {
  const c1 = 1.20158;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

// ---------- the stroke ----------

class ReefStroke implements StrokeInstance {
  readonly group = new THREE.Group();

  private settings: ReefSettings;
  private readonly total: number;
  private grown = 0;
  private structuresDone = false;

  private segments: Segment[] = [];
  private tips: Tip[] = [];
  private tendrils: Tendril[] = [];
  private fans: Fan[] = [];
  private plankton: Plankter[] = [];

  private segMesh!: THREE.InstancedMesh;
  private tipMesh!: THREE.InstancedMesh;
  private tendrilMesh!: THREE.InstancedMesh;
  private fanMesh!: THREE.InstancedMesh;
  private planktonMesh!: THREE.InstancedMesh;

  private lights: { light: THREE.PointLight; dist: number; phase: number }[] = [];

  constructor(samples: SurfaceSample[], seed: number, settings: ReefSettings) {
    this.settings = { ...settings };
    const rnd = mulberry32(seed);
    this.total = this.scatter(samples, rnd);

    const make = (geo: THREE.BufferGeometry, mat: THREE.Material, count: number, shadows: boolean): THREE.InstancedMesh => {
      const mesh = new THREE.InstancedMesh(geo, mat, Math.max(count, 1));
      mesh.castShadow = shadows;
      mesh.receiveShadow = shadows;
      mesh.frustumCulled = false;
      for (let i = 0; i < count; i++) mesh.setMatrixAt(i, _zero);
      mesh.count = Math.max(count, 1);
      mesh.instanceMatrix.needsUpdate = true;
      this.group.add(mesh);
      return mesh;
    };
    this.segMesh = make(getCoralGeometry(), getCoralMaterial(), this.segments.length, true);
    this.tipMesh = make(getTipGeometry(), getTipMaterial(), this.tips.length, false);
    this.tendrilMesh = make(getTendrilGeometry(), getTendrilMaterial(), this.tendrils.length, false);
    this.fanMesh = make(getFanGeometry(), getFanMaterial(), this.fans.length, false);
    this.planktonMesh = make(new THREE.PlaneGeometry(1, 1), getPlanktonMaterial(), MAX_PLANKTON, false);
    this.planktonMesh.renderOrder = 3;

    // Body tints per segment.
    for (let i = 0; i < this.segments.length; i++) {
      const pal = PALETTES[settings.palette];
      _color.copy(pal.bodyA).lerp(pal.bodyB, this.segments[i].bodyMix);
      this.segMesh.setColorAt(i, _color);
    }
    if (this.segMesh.instanceColor) this.segMesh.instanceColor.needsUpdate = true;

    // Light spill: breathing teal lights along the path.
    const nLights = Math.min(3, Math.max(1, Math.round(this.total * 1.2)));
    for (let i = 0; i < nLights; i++) {
      const f = nLights === 1 ? 0.5 : 0.15 + (0.7 * i) / (nLights - 1);
      const idx = Math.floor((samples.length - 1) * f);
      const light = new THREE.PointLight(0x2ee6d6, 0, 1.4, 2);
      light.position.copy(samples[idx].local).addScaledVector(samples[idx].localNormal, 0.12);
      this.group.add(light);
      this.lights.push({ light, dist: this.total * f, phase: rnd() * 20 });
    }

    this.applySettings(settings);
  }

  // ----- generation (at slider maxima; sliders cull live) -----

  private scatter(samples: SurfaceSample[], rnd: () => number): number {
    const spacing = 1 / MAX_DENSITY;
    let travelled = 0;
    let next = spacing * 0.4;
    const tangent = new THREE.Vector3();

    for (let i = 0; i < samples.length; i++) {
      if (i > 0) travelled += samples[i].local.distanceTo(samples[i - 1].local);
      if (travelled < next) continue;
      next = travelled + spacing * (0.8 + rnd() * 0.4);

      const a = samples[Math.max(i - 1, 0)];
      const b = samples[Math.min(i + 1, samples.length - 1)];
      tangent.subVectors(b.local, a.local).normalize();
      const n = samples[i].localNormal.clone().normalize();
      const side = new THREE.Vector3().crossVectors(tangent, n).normalize();
      const clusterRnd = rnd();
      const kind = rnd();

      if (kind < 0.55) {
        this.growCoral(samples[i].local, n, side, travelled, clusterRnd, rnd);
      } else if (kind < 0.8) {
        this.growAnemone(samples[i].local, n, side, travelled, clusterRnd, rnd);
      } else {
        this.growFan(samples[i].local, n, side, tangent, travelled, clusterRnd, rnd);
      }

      // Plankton hovers around every cluster site.
      const motes = 4 + Math.floor(rnd() * 4);
      for (let k = 0; k < motes && this.plankton.length < MAX_PLANKTON; k++) {
        this.plankton.push({
          center: samples[i].local.clone(),
          up: n,
          side,
          radius: 0.06 + rnd() * 0.3,
          height: 0.06 + rnd() * 0.4,
          speed: (0.15 + rnd() * 0.35) * (rnd() < 0.5 ? 1 : -1),
          phase: rnd() * Math.PI * 2,
          size: 0.006 + rnd() * 0.012,
          colorMix: rnd(),
          dist: travelled,
          quat: new THREE.Quaternion().setFromEuler(
            new THREE.Euler(rnd() * Math.PI, rnd() * Math.PI, rnd() * Math.PI),
          ),
        });
      }
    }
    return travelled;
  }

  /** Recursive staghorn: every segment ends in a glowing polyp bud. Segment/tip positions
   *  are UNIT-space offsets from the colony's surface anchor, so the colony-size slider is
   *  a pure re-pose. */
  private growCoral(
    base: THREE.Vector3, n: THREE.Vector3, side: THREE.Vector3,
    dist: number, clusterRnd: number, rnd: () => number,
  ): void {
    const grow = (pos: THREE.Vector3, dir: THREE.Vector3, depth: number, lenMul: number): void => {
      const len = lenMul * (0.85 + rnd() * 0.3);
      const rad = 0.16 * Math.pow(0.62, depth) * (0.8 + rnd() * 0.4);
      const quat = new THREE.Quaternion().setFromUnitVectors(_Y, dir);
      const segIndex = this.segments.length;
      this.segments.push({
        anchor: base,
        pos: pos.clone(), quat, len, rad, depth,
        cullRnd: rnd(), clusterRnd,
        birth: dist + depth * 0.1 + rnd() * 0.05,
        bodyMix: rnd(),
        visible: true,
      });
      const end = pos.clone().addScaledVector(dir, len);
      // Polyps stud the whole branch, not just the end — the beaded-light staghorn look.
      this.tips.push({
        segIndex,
        offset: end.clone(),
        size: 0.11 * Math.pow(0.8, depth) * (0.8 + rnd() * 0.5),
        birth: dist + depth * 0.1 + 0.08,
      });
      for (const f of [0.55, 0.82]) {
        this.tips.push({
          segIndex,
          offset: pos.clone().addScaledVector(dir, len * f),
          size: 0.065 * Math.pow(0.8, depth) * (0.7 + rnd() * 0.5),
          birth: dist + depth * 0.1 + 0.05 + f * 0.05,
        });
      }

      if (depth >= MAX_DEPTH) return;
      const kids = 2 + (rnd() < 0.3 ? 1 : 0);
      for (let k = 0; k < kids; k++) {
        const az = rnd() * Math.PI * 2;
        const tiltAngle = 0.4 + rnd() * 0.55;
        _t1.copy(side);
        _t2.crossVectors(dir, _t1).normalize();
        _dir.copy(dir).multiplyScalar(Math.cos(tiltAngle))
          .addScaledVector(_t1, Math.cos(az) * Math.sin(tiltAngle))
          .addScaledVector(_t2, Math.sin(az) * Math.sin(tiltAngle))
          .normalize();
        grow(end, _dir.clone(), depth + 1, lenMul * 0.68);
      }
    };

    const trunkDir = n.clone();
    _t2.crossVectors(n, side);
    trunkDir.addScaledVector(side, (rnd() - 0.5) * 0.5).addScaledVector(_t2, (rnd() - 0.5) * 0.5).normalize();
    grow(new THREE.Vector3(0, 0, 0), trunkDir, 0, 1);
  }

  private growAnemone(
    base: THREE.Vector3, n: THREE.Vector3, side: THREE.Vector3,
    dist: number, clusterRnd: number, rnd: () => number,
  ): void {
    _t2.crossVectors(n, side);
    for (let k = 0; k < MAX_TENDRILS; k++) {
      const az = rnd() * Math.PI * 2;
      const tilt = 0.15 + rnd() * 0.7;
      _dir.copy(n).multiplyScalar(Math.cos(tilt))
        .addScaledVector(side, Math.cos(az) * Math.sin(tilt))
        .addScaledVector(_t2, Math.sin(az) * Math.sin(tilt))
        .normalize();
      const quat = new THREE.Quaternion().setFromUnitVectors(_Y, _dir);
      _q.setFromAxisAngle(_dir, rnd() * Math.PI * 2);
      quat.premultiply(_q);
      this.tendrils.push({
        pos: base.clone()
          .addScaledVector(side, (rnd() - 0.5) * 0.05)
          .addScaledVector(_t2, (rnd() - 0.5) * 0.05),
        quat,
        len: 0.55 + rnd() * 0.6,
        rank: k,
        clusterRnd,
        birth: dist + rnd() * 0.12,
        visible: true,
      });
    }
  }

  private growFan(
    base: THREE.Vector3, n: THREE.Vector3, side: THREE.Vector3, tangent: THREE.Vector3,
    dist: number, clusterRnd: number, rnd: () => number,
  ): void {
    // The fan plane faces across the current: X along the stroke, Y off the surface.
    const basis = new THREE.Matrix4().makeBasis(
      tangent.clone(),
      n.clone(),
      new THREE.Vector3().crossVectors(tangent, n),
    );
    const quat = new THREE.Quaternion().setFromRotationMatrix(basis);
    _q.setFromAxisAngle(n, (rnd() - 0.5) * 0.8);
    quat.premultiply(_q);
    this.fans.push({
      pos: base.clone(),
      quat,
      size: 1.0 + rnd() * 0.8,
      clusterRnd,
      birth: dist + 0.05,
      visible: true,
    });
  }

  // ----- live settings -----

  applySettings(settings: unknown): void {
    const s = settings as ReefSettings;
    this.settings = { ...s };
    setReefStyle(s);

    const densityFrac = s.density / MAX_DENSITY;
    // Depth cull with a smooth fraction per generation: at branching=1 every generation
    // survives; at 0.5 trees stop at depth 2; the trunk always stays.
    const depthCut = s.branching * (MAX_DEPTH + 1) + 0.5;
    for (const seg of this.segments) {
      seg.visible = seg.clusterRnd <= densityFrac &&
        (seg.depth === 0 || seg.cullRnd < depthCut - seg.depth);
    }
    for (const td of this.tendrils) {
      td.visible = td.clusterRnd <= densityFrac && td.rank < s.tendrils;
    }
    for (const fan of this.fans) {
      fan.visible = fan.clusterRnd <= densityFrac;
    }

    // Retint coral bodies for the palette.
    const pal = PALETTES[s.palette];
    for (let i = 0; i < this.segments.length; i++) {
      _color.copy(pal.bodyA).lerp(pal.bodyB, this.segments[i].bodyMix);
      this.segMesh.setColorAt(i, _color);
    }
    if (this.segMesh.instanceColor) this.segMesh.instanceColor.needsUpdate = true;

    this.structuresDone = false;
    this.pose(true);
  }

  // ----- StrokeInstance -----

  update(dt: number, t: number): void {
    if (this.grown < this.total + 1.2) {
      this.grown += dt * this.settings.growthSpeed;
    }
    if (!this.structuresDone) this.pose(false);
    this.updatePlankton(t);
    this.updateLights(t);
  }

  finishGrowth(): void {
    this.grown = this.total + 2;
    this.pose(true);
  }

  private pose(force: boolean): void {
    const GROW = 0.35;
    const size = this.settings.colonySize;
    let allDone = this.grown >= this.total + GROW + 0.6;

    // Coral segments (positions are unit-space offsets around their anchor).
    let dirty = force;
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      if (!seg.visible) {
        if (force) this.segMesh.setMatrixAt(i, _zero);
        continue;
      }
      const t = (this.grown - seg.birth) / GROW;
      if (t <= 0) {
        if (force) this.segMesh.setMatrixAt(i, _zero);
        allDone = false;
        continue;
      }
      const k = t >= 1 ? 1 : easeOutBack(t);
      if (t < 1.2 || force) {
        _p.copy(seg.anchor).addScaledVector(seg.pos, size);
        _s.set(seg.rad * size * (0.7 + 0.3 * k), seg.len * size * k, seg.rad * size * (0.7 + 0.3 * k));
        _m.compose(_p, seg.quat, _s);
        this.segMesh.setMatrixAt(i, _m);
        dirty = true;
        if (t < 1) allDone = false;
      }
    }
    if (dirty) this.segMesh.instanceMatrix.needsUpdate = true;

    // Polyp tips ride their segments (spheres — identity orientation).
    dirty = force;
    for (let i = 0; i < this.tips.length; i++) {
      const tip = this.tips[i];
      const seg = this.segments[tip.segIndex];
      if (!seg.visible) {
        if (force) this.tipMesh.setMatrixAt(i, _zero);
        continue;
      }
      const t = (this.grown - tip.birth) / GROW;
      if (t <= 0) {
        if (force) this.tipMesh.setMatrixAt(i, _zero);
        allDone = false;
        continue;
      }
      const k = t >= 1 ? 1 : easeOutBack(t);
      if (t < 1.2 || force) {
        _p.copy(seg.anchor).addScaledVector(tip.offset, size);
        _s.setScalar(tip.size * size * k);
        _m.compose(_p, _q.identity(), _s);
        this.tipMesh.setMatrixAt(i, _m);
        dirty = true;
        if (t < 1) allDone = false;
      }
    }
    if (dirty) this.tipMesh.instanceMatrix.needsUpdate = true;

    // Tendrils.
    dirty = force;
    for (let i = 0; i < this.tendrils.length; i++) {
      const td = this.tendrils[i];
      if (!td.visible) {
        if (force) this.tendrilMesh.setMatrixAt(i, _zero);
        continue;
      }
      const t = (this.grown - td.birth) / GROW;
      if (t <= 0) {
        if (force) this.tendrilMesh.setMatrixAt(i, _zero);
        allDone = false;
        continue;
      }
      const k = t >= 1 ? 1 : easeOutBack(t);
      if (t < 1.2 || force) {
        const len = td.len * size * 1.4;
        _s.set(0.055 * size, len * k, 0.055 * size);
        _m.compose(td.pos, td.quat, _s);
        this.tendrilMesh.setMatrixAt(i, _m);
        dirty = true;
        if (t < 1) allDone = false;
      }
    }
    if (dirty) this.tendrilMesh.instanceMatrix.needsUpdate = true;

    // Fans.
    dirty = force;
    for (let i = 0; i < this.fans.length; i++) {
      const fan = this.fans[i];
      if (!fan.visible) {
        if (force) this.fanMesh.setMatrixAt(i, _zero);
        continue;
      }
      const t = (this.grown - fan.birth) / GROW;
      if (t <= 0) {
        if (force) this.fanMesh.setMatrixAt(i, _zero);
        allDone = false;
        continue;
      }
      const k = t >= 1 ? 1 : easeOutBack(t);
      if (t < 1.2 || force) {
        _s.setScalar(fan.size * size * k);
        _m.compose(fan.pos, fan.quat, _s);
        this.fanMesh.setMatrixAt(i, _m);
        dirty = true;
        if (t < 1) allDone = false;
      }
    }
    if (dirty) this.fanMesh.instanceMatrix.needsUpdate = true;

    if (allDone) this.structuresDone = true;
  }

  private updatePlankton(t: number): void {
    const s = this.settings;
    const pal = PALETTES[s.palette];
    _cA.copy(pal.glowA);
    _cB.copy(pal.glowB);
    for (let i = 0; i < this.plankton.length; i++) {
      const pk = this.plankton[i];
      if (i >= s.plankton || pk.dist > this.grown) {
        this.planktonMesh.setMatrixAt(i, _zero);
        continue;
      }
      const ang = t * pk.speed + pk.phase;
      _t2.crossVectors(pk.up, pk.side);
      _p.copy(pk.center)
        .addScaledVector(pk.side, Math.cos(ang) * pk.radius)
        .addScaledVector(_t2, Math.sin(ang) * pk.radius)
        .addScaledVector(pk.up, pk.height + Math.sin(t * 0.5 + pk.phase * 2) * 0.04);
      const tw = Math.pow(0.5 + 0.5 * Math.sin(t * (1.2 + pk.phase % 1.5) * 2 + pk.phase), 2.5);
      _s.setScalar(pk.size * (0.7 + tw * 0.6));
      _m.compose(_p, pk.quat, _s);
      this.planktonMesh.setMatrixAt(i, _m);
      _color.copy(_cA).lerp(_cB, pk.colorMix).multiplyScalar((0.2 + tw * 1.2) * s.glow);
      this.planktonMesh.setColorAt(i, _color);
    }
    this.planktonMesh.instanceMatrix.needsUpdate = true;
    if (this.planktonMesh.instanceColor) this.planktonMesh.instanceColor.needsUpdate = true;
  }

  private updateLights(t: number): void {
    const pal = PALETTES[this.settings.palette];
    for (const { light, dist, phase } of this.lights) {
      if (this.grown <= dist) {
        light.intensity = 0;
        continue;
      }
      const ignite = THREE.MathUtils.clamp((this.grown - dist) / 0.5, 0, 1);
      const breathe = 0.7 + 0.3 * Math.sin(t * 0.8 * this.settings.pulseSpeed + phase);
      light.color.copy(pal.glowA);
      light.intensity = this.settings.lightSpill * 1.1 * ignite * breathe;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    // Geometries + materials are shared; only instance buffers are per-stroke
    // (plankton's quad geometry is per-stroke).
    this.planktonMesh.geometry.dispose();
    for (const m of [this.segMesh, this.tipMesh, this.tendrilMesh, this.fanMesh, this.planktonMesh]) {
      m.dispose();
    }
  }
}

// ---------- the mode ----------

export const reefMode: PaintMode<ReefSettings> = {
  id: 'Bioluminescent reef',
  createStroke(samples, seed, settings): StrokeInstance {
    return new ReefStroke(samples, seed, settings);
  },
};

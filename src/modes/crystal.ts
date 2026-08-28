import * as THREE from "three";
import {mulberry32, PaintMode, StrokeInstance, SurfaceSample} from "./mode";

export type CrystalPaletteName =
  | "Amethyst"
  | "Ice"
  | "Emerald"
  | "Citrine"
  | "Rose"
  | "Prism";

export interface CrystalSettings {
  palette: CrystalPaletteName;
  clusterDensity: number;
  crystalSize: number;
  shards: number;
  spread: number;
  tilt: number;
  sizeJitter: number;
  clearMix: number;
  glow: number;
  growthSpeed: number;
}

export const defaultCrystalSettings: CrystalSettings = {
  palette: "Amethyst",
  clusterDensity: 7,
  crystalSize: 0.17,
  shards: 7,
  spread: 1.0,
  tilt: 0.4,
  sizeJitter: 0.55,
  clearMix: 0.35,
  glow: 0,
  growthSpeed: 1.4,
};

export const MAX_DENSITY = 16;
export const MAX_SHARDS = 16;

interface Palette {
  base: THREE.Color;
  attenuation: THREE.Color;
  emissive: THREE.Color;
  hueJitter: number;
}

const PALETTES: Record<CrystalPaletteName, Palette> = {
  Amethyst: {
    base: new THREE.Color(0xa878e8),
    attenuation: new THREE.Color(0x7a2fd6),
    emissive: new THREE.Color(0x8a5cff),
    hueJitter: 0.045,
  },
  Ice: {
    base: new THREE.Color(0xcfe8ff),
    attenuation: new THREE.Color(0x5aa6e8),
    emissive: new THREE.Color(0x7fc4ff),
    hueJitter: 0.03,
  },
  Emerald: {
    base: new THREE.Color(0x74e8a0),
    attenuation: new THREE.Color(0x0f9c4a),
    emissive: new THREE.Color(0x3cf58a),
    hueJitter: 0.04,
  },
  Citrine: {
    base: new THREE.Color(0xf5c76a),
    attenuation: new THREE.Color(0xd68a1e),
    emissive: new THREE.Color(0xffb84d),
    hueJitter: 0.035,
  },
  Rose: {
    base: new THREE.Color(0xf5a8c8),
    attenuation: new THREE.Color(0xd6488a),
    emissive: new THREE.Color(0xff7ab8),
    hueJitter: 0.03,
  },
  Prism: {
    base: new THREE.Color(0xe8ecf5),
    attenuation: new THREE.Color(0x9aa8c4),
    emissive: new THREE.Color(0xbcc8ff),
    hueJitter: 1.0,
  },
};

function makeCrystalGeometry(rnd: () => number): THREE.BufferGeometry {
  const sides = 6;
  const baseR = 0.16 + rnd() * 0.1;
  const shaftH = 0.55 + rnd() * 0.2;
  const taper = 0.78 + rnd() * 0.16;
  const apex = new THREE.Vector3((rnd() - 0.5) * 0.14, 1, (rnd() - 0.5) * 0.14);

  const angles: number[] = [];
  const radii: number[] = [];

  for (let i = 0; i < sides; i++) {
    angles.push(((i + (rnd() - 0.5) * 0.34) / sides) * Math.PI * 2);
    radii.push(baseR * (0.8 + rnd() * 0.4));
  }

  const lower: THREE.Vector3[] = [];
  const upper: THREE.Vector3[] = [];

  for (let i = 0; i < sides; i++) {
    const c = Math.cos(angles[i]);
    const s = Math.sin(angles[i]);

    lower.push(new THREE.Vector3(c * radii[i], 0, s * radii[i]));
    upper.push(
      new THREE.Vector3(c * radii[i] * taper, shaftH, s * radii[i] * taper),
    );
  }

  const positions: number[] = [];
  const push = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };
  const bottom = new THREE.Vector3(0, -0.02, 0);

  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;

    push(lower[i], upper[i], upper[j]);
    push(lower[i], upper[j], lower[j]);
    push(upper[i], apex, upper[j]);
    push(lower[j], bottom, lower[i]);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();

  return geo;
}

const VARIANTS = 5;
let variantGeos: THREE.BufferGeometry[] | null = null;

function getVariantGeometries(): THREE.BufferGeometry[] {
  if (!variantGeos) {
    const rnd = mulberry32(0xc0ffee);

    variantGeos = Array.from({length: VARIANTS}, () =>
      makeCrystalGeometry(rnd),
    );
  }

  return variantGeos;
}

const materials = new Map<CrystalPaletteName, THREE.MeshPhysicalMaterial>();

function getMaterial(
  name: CrystalPaletteName,
  glow: number,
): THREE.MeshPhysicalMaterial {
  let mat = materials.get(name);

  if (!mat) {
    const p = PALETTES[name];

    mat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      metalness: 0,
      roughness: 0.05,
      transmission: 0.7,
      ior: 1.55,
      thickness: 0.4,
      attenuationColor: p.attenuation,
      attenuationDistance: 0.5,
      dispersion: 0.3,
      iridescence: 0.4,
      iridescenceIOR: 1.3,
      clearcoat: 0.5,
      clearcoatRoughness: 0.12,
      specularIntensity: 1,
      emissive: p.emissive,
      emissiveIntensity: glow,
      envMapIntensity: 1.6,
    });

    materials.set(name, mat);
  }

  mat.emissiveIntensity = glow;

  return mat;
}

let clearMaterial: THREE.MeshPhysicalMaterial | null = null;

function getClearMaterial(glow: number): THREE.MeshPhysicalMaterial {
  if (!clearMaterial) {
    clearMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      metalness: 0,
      roughness: 0.02,
      transmission: 1,
      ior: 1.55,
      thickness: 0.5,
      attenuationColor: 0xdfe8ff,
      attenuationDistance: 1.6,
      dispersion: 0.4,
      iridescence: 0.15,
      iridescenceIOR: 1.3,
      clearcoat: 0.6,
      clearcoatRoughness: 0.08,
      specularIntensity: 1.2,
      emissive: 0xcfd8ff,
      emissiveIntensity: glow * 0.35,
      envMapIntensity: 2.0,
    });
  }

  clearMaterial.emissiveIntensity = glow * 0.35;

  return clearMaterial;
}

export function setCrystalGlow(glow: number): void {
  for (const mat of materials.values()) mat.emissiveIntensity = glow;

  if (clearMaterial) {
    clearMaterial.emissiveIntensity = glow * 0.35;
  }
}

type CrystalKind = "main" | "shard" | "rubble";

interface CrystalInstance {
  variant: number;
  kind: CrystalKind;
  anchor: THREE.Vector3;
  n: THREE.Vector3;
  t1: THREE.Vector3;
  t2: THREE.Vector3;
  birth: number;
  clusterRnd: number;
  shardIndex: number;
  shardCountRnd: number;
  offAz: number;
  offFrac: number;
  heightBase: number;
  jitterRnd: number;
  widthRnd: number;
  tiltScale: number;
  leanRnd: number;
  leanAz: number;
  spin: number;
  hueRnd: number;
  satRnd: number;
  lightRnd: number;
  clearRnd: number;
  visible: boolean;
  isClear: boolean;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  scale: THREE.Vector3;
  color: THREE.Color;
}

const GROW_WINDOW = 0.45;
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _align = new THREE.Quaternion();
const _Y = new THREE.Vector3(0, 1, 0);
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _hsl = {h: 0, s: 0, l: 0};
const _white = new THREE.Color(0xffffff);
const _clearTint = new THREE.Color();

function easeOutBack(t: number): number {
  const c1 = 1.20158;
  const c3 = c1 + 1;
  const u = t - 1;

  return 1 + c3 * u * u * u + c1 * u * u;
}

class CrystalStroke implements StrokeInstance {
  readonly group = new THREE.Group();

  private tinted: THREE.InstancedMesh[] = [];
  private clear: THREE.InstancedMesh[] = [];
  private byVariant: CrystalInstance[][];
  private settings: CrystalSettings;
  private grown = 0;
  private readonly total: number;
  private done = false;

  constructor(
    samples: SurfaceSample[],
    seed: number,
    settings: CrystalSettings,
  ) {
    this.settings = {...settings};
    const rnd = mulberry32(seed);
    const instaces = this.scatter(samples, rnd);

    this.byVariant = Array.from({length: VARIANTS}, () => []);
    for (const inst of instaces) this.byVariant[inst.variant].push(inst);

    const geos = getVariantGeometries();
    const tintedMat = getMaterial(settings.palette, settings.glow);
    const clearMat = getClearMaterial(settings.glow);
    const makeMesh = (
      v: number,
      mat: THREE.MeshPhysicalMaterial,
    ): THREE.InstancedMesh => {
      const list = this.byVariant[v];
      const mesh = new THREE.InstancedMesh(
        geos[v],
        mat,
        Math.max(list.length, 1),
      );

      for (let i = 0; i < list.length; i++) mesh.setMatrixAt(i, _zero);

      mesh.count == list.length;
      mesh.instanceMatrix.needsUpdate = true;
      this.group.add(mesh);

      return mesh;
    };

    for (let v = 0; v < VARIANTS; v++) {
      this.tinted.push(makeMesh(v, tintedMat));
      this.clear.push(makeMesh(v, clearMat));
    }

    this.total = this.strokeLength(samples);
    this.applySettings(settings);
  }

  private strokeLength(samples: SurfaceSample[]): number {
    let d = 0;

    for (let i = 1; i < samples.length; i++)
      d += samples[i].local.distanceTo(samples[i + 1].local);

    return d;
  }

  private scatter(
    samples: SurfaceSample[],
    rnd: () => number,
  ): CrystalInstance[] {
    const out: CrystalInstance[] = [];
    const spacing = 1 / MAX_DENSITY;

    let travelled = 0;
    let nextAt = 0;

    for (let i = 0; i < samples.length; i++) {
      if (i > 0) {
        travelled += samples[i].local.distanceTo(samples[i - 1].local);
      }

      if (travelled < nextAt) continue;

      nextAt = travelled + spacing * (0.75 + rnd() * 0.5);
      this.cluster(out, samples[i], travelled, rnd);
    }

    return out;
  }
  private cluster(
    out: CrystalInstance[],
    sample: SurfaceSample,
    dist: number,
    rnd: () => number,
  ): void {
    const n = sample.localNormal.clone();
    const t1 = new THREE.Vector3(1, 0, 0);

    if (Math.abs(n.x) > 0.9) {
      t1.set(0, 1, 0);
    }

    t1.cross(n).normalize();

    const t2 = new THREE.Vector3().crossVectors(n, t1);
    const clusterRnd = rnd();
    const shardCountRnd = rnd();

    const add = (
      kind: CrystalKind,
      shardIndex: number,
      offFrac: number,
      heightBase: number,
      tiltScale: number,
      birthLag: number,
    ): void => {
      out.push({
        variant: Math.floor(rnd() * VARIANTS),
        kind,
        anchor: sample.local,
        n,
        t1,
        t2,
        birth: dist + birthLag + rnd() * 0.12,
        clusterRnd,
        shardIndex,
        shardCountRnd,
        offAz: rnd() * Math.PI * 2,
        offFrac,
        heightBase,
        jitterRnd: rnd(),
        widthRnd: rnd(),
        tiltScale,
        leanRnd: rnd(),
        leanAz: rnd() * Math.PI * 2,
        spin: rnd() * Math.PI * 2,
        hueRnd: rnd(),
        satRnd: rnd(),
        lightRnd: rnd(),
        clearRnd: rnd(),
        visible: true,
        isClear: false,
        pos: new THREE.Vector3(),
        quat: new THREE.Quaternion(),
        scale: new THREE.Vector3(1, 1, 1),
        color: new THREE.Color(),
      });
    };

    add("main", -1, 0.15 * rnd(), 1.1 + rnd() * 0.5, 0.55, 0);

    for (let k = 0; k < MAX_SHARDS; k++) {
      add(
        "shard",
        k,
        0.25 + rnd() * 0.75,
        0.35 + rnd() * 0.4,
        1,
        0.05 + rnd() * 0.01,
      );
    }

    const rubble = 2 + Math.floor(rnd() * 3);

    for (let k = 0; k < rubble; k++) {
      add(
        "rubble",
        -1,
        0.6 + rnd() * 0.7,
        0.12 + rnd() * 0.12,
        1.3,
        0.12 + rnd() * 0.15,
      );
    }
  }

  applySettings(settings: unknown): void {
    const s = settings as CrystalSettings;
    this.settings = {...s};
    const palette = PALETTES[s.palette];
    const tintedMat = getMaterial(s.palette, s.glow);
    const clearMat = getClearMaterial(s.glow);
    const footprint = s.crystalSize * s.spread;
    const densityFrac = s.clusterDensity / MAX_DENSITY;

    for (let v = 0; v < VARIANTS; v++) {
      const tMesh = this.tinted[v];
      const cMesh = this.clear[v];

      if (tMesh.material !== tintedMat) {
        tMesh.material = tintedMat;
      }

      if (cMesh.material !== clearMat) {
        cMesh.material = clearMat;
      }

      const list = this.byVariant[v];

      for (let i = 0; i < list.length; i++) {
        const inst = list[i];
        const shardCap = Math.round(
          s.shards * (0.7 + inst.shardCountRnd * 0.6),
        );

        inst.visible =
          inst.clusterRnd <= densityFrac &&
          (inst.kind !== "shard" || inst.shardIndex < shardCap);

        inst.isClear = inst.clearRnd < s.clearMix;

        const jitterMul =
          1 - s.sizeJitter * 0.5 + inst.jitterRnd * s.sizeJitter;
        const h = inst.heightBase * s.crystalSize * jitterMul;
        const w = h * (0.8 + inst.widthRnd * 0.45);

        inst.scale.set(w, h, w);

        const lean =
          s.tilt * inst.tiltScale * (0.25 + inst.leanRnd * 0.75) * 0.9;

        _dir
          .copy(inst.n)
          .multiplyScalar(Math.cos(lean))
          .addScaledVector(inst.t1, Math.cos(inst.leanAz) * Math.sin(lean))
          .addScaledVector(inst.t2, Math.sin(inst.leanAz) * Math.sin(lean))
          .normalize();

        _align.setFromUnitVectors(_Y, _dir);
        inst.quat.setFromAxisAngle(_dir, inst.spin).multiply(_align);

        inst.pos
          .copy(inst.anchor)
          .addScaledVector(
            inst.t1,
            Math.cos(inst.offAz) * inst.offFrac * footprint,
          )
          .addScaledVector(
            inst.t2,
            Math.sin(inst.offAz) * inst.offFrac * footprint,
          )
          .addScaledVector(inst.n, -0.05 * h);

        inst.color.copy(palette.base);
        inst.color.getHSL(_hsl);
        inst.color.setHSL(
          (_hsl.h + (inst.hueRnd - 0.5) * palette.hueJitter + 1) % 1,
          THREE.MathUtils.clamp(_hsl.s * (1.15 + inst.satRnd * 0.35), 0, 1),
          THREE.MathUtils.clamp(_hsl.l * (0.8 + inst.lightRnd * 0.45), 0, 1),
        );
        tMesh.setColorAt(i, inst.color);
        _clearTint.copy(inst.color).lerp(_white, 0.82 + inst.lightRnd * 0.12);
        cMesh.setColorAt(i, _clearTint);
      }

      if (tMesh.instanceColor) {
        tMesh.instanceColor.needsUpdate = true;
      }

      if (cMesh.instanceColor) {
        cMesh.instanceColor.needsUpdate = true;
      }
    }

    this.done = false;
    this.pose(true);
  }

  update(dt: number, _time: number): void {
    if (this.done) return;

    this.grown += dt * this.settings.growthSpeed;
    this.pose(false);
  }

  finishGrowth(): void {
    this.grown = this.total + GROW_WINDOW + 1;
    this.pose(true);
  }

  private pose(force: boolean): void {
    let allDone = this.grown >= this.total + GROW_WINDOW + 0.3;

    for (let v = 0; v < VARIANTS; v++) {
      const list = this.byVariant[v];
      const tMesh = this.tinted[v];
      const cMesh = this.clear[v];
      let dirty = force;

      for (let i = 0; i < list.length; i++) {
        const inst = list[i];
        const on = inst.isClear ? cMesh : tMesh;
        const off = inst.isClear ? tMesh : cMesh;

        if (!inst.visible) {
          if (force) {
            on.setMatrixAt(i, _zero);
            off.setMatrixAt(i, _zero);
          }
          continue;
        }

        const t = (this.grown - inst.birth) / GROW_WINDOW;

        if (t <= 0) {
          if (force) {
            on.setMatrixAt(i, _zero);
            off.setMatrixAt(i, _zero);
          }

          allDone = false;

          continue;
        }

        const k = t >= 1 ? 1 : easeOutBack(t);

        if (t < 1.2 || force) {
          _s.set(
            inst.scale.x * k * (0.6 + 0.4 * k),
            inst.scale.y * k,
            inst.scale.z * k * (0.6 + 0.4 * k),
          );
          _m.compose(inst.pos, inst.quat, _s);
          on.setMatrixAt(i, _m);

          if (force) {
            off.setMatrixAt(i, _zero);
          }

          dirty = true;

          if (t < 1) {
            allDone = false;
          }
        }
      }

      if (dirty) {
        tMesh.instanceMatrix.needsUpdate = true;
        cMesh.instanceMatrix.needsUpdate = true;
      }
    }

    if (allDone) {
      this.done = true;
    }
  }

  dispose(): void {
    this.group.removeFromParent();

    for (const mesh of this.tinted) mesh.dispose();
    for (const mesh of this.clear) mesh.dispose();
  }
}

export const crystalMode: PaintMode<CrystalSettings> = {
  id: "Crystals",
  createStroke(samples, seed, settings): StrokeInstance {
    return new CrystalStroke(samples, seed, settings);
  },
};

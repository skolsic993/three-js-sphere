import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { buildCrystalGoldMaps, loadGoldStrip } from "../goldMaps";
import {
  mulberry32,
  type PaintMode,
  type StrokeInstance,
  type SurfaceSample,
} from "./mode";

/**
 * Crystal painting mode. Each stroke seeds clusters of rounded gold-nugget chunks along the
 * painted path: one dominant nugget per cluster surrounded by smaller shards and rubble,
 * lightly sunk into the surface. Citrine reads as scratched metallic ore; other palettes
 * stay transmissive glass on the same mesh, growing in with an elastic pop as the growth
 * front sweeps along the stroke.
 *
 * Every slider is TRULY live: a stroke stores each crystal's generative parameters (anchor,
 * tangent frame, stable randoms) rather than baked matrices, and instances are allocated at
 * the slider maxima. Changing size/spread/tilt/jitter/palette recomposes matrices and colors
 * in place; changing density/shards zero-scales culled instances — nothing is ever
 * disposed or recreated while you drag.
 */

export type CrystalPaletteName =
  | "Amethyst"
  | "Ice"
  | "Emerald"
  | "Citrine"
  | "Rose"
  | "Prism";

export interface CrystalSettings {
  palette: CrystalPaletteName;
  /**
   * 0..1 — fraction of the rock surface to pre-fill with crystal *veins*
   * on load (and when this / seed changes). 0.65 ≈ 65% as path-like seams
   * across the stone, not a salt scatter. Paint strokes stack on top.
   */
  surfaceCoverage: number;
  clusterDensity: number; // clusters per world unit of stroke (live-culled up to MAX_DENSITY)
  crystalSize: number; // size of a cluster's main nugget (world units)
  shards: number; // secondary crystals per cluster (live-culled up to MAX_SHARDS)
  spread: number; // cluster footprint, as a multiple of crystalSize
  tilt: number; // 0..1 — how far crystals lean away from the surface normal
  sizeJitter: number; // 0..1 — per-crystal size variation
  clearMix: number; // 0..1 — fraction of crystals that are clear refractive quartz
  glow: number; // emissive intensity (feeds the bloom pass)
  growthSpeed: number; // world units of stroke length grown per second
}

export const defaultCrystalSettings: CrystalSettings = {
  palette: "Citrine",
  surfaceCoverage: 0.05,
  clusterDensity: 16,
  crystalSize: 0.035,
  shards: 7,
  spread: 1.6,
  tilt: 0.4,
  sizeJitter: 1,
  clearMix: 0,
  glow: 0,
  growthSpeed: 1.4,
};

/** Instances are generated at these maxima; the density/shard sliders cull, never rebuild.
 *  Keep in sync with the GUI slider ranges. */
export const MAX_DENSITY = 16;
export const MAX_SHARDS = 16;

// ---------- palettes ----------

interface Palette {
  base: THREE.Color; // per-instance tint base
  attenuation: THREE.Color; // color light turns while passing through (the "body" color)
  emissive: THREE.Color; // faint inner light, amplified by the glow slider + bloom
  hueJitter: number; // per-crystal hue variation (0..1 of the full wheel)
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
  // Gold ore look: opaque metal, not glass. Reflectance ~0xffe29b (measured gold → sRGB).
  Citrine: {
    base: new THREE.Color(0xffe29b),
    attenuation: new THREE.Color(0xc9a227),
    emissive: new THREE.Color(0xffc050),
    hueJitter: 0.02,
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
    hueJitter: 1.0, // full rainbow spread per crystal
  },
};

// ---------- shared geometry variants ----------

/**
 * Irregular gold-nugget chunk: subdivided box, non-uniform axes, rounded corners + noise.
 * Vertices are welded so averaged normals read soft ore at zoom — not razor crystal tips.
 * Normalized to height 1 with the base at y=0.
 */
function makeCrystalGeometry(rnd: () => number): THREE.BufferGeometry {
  // 3 segs/axis gives edge midpoints so corner rounding has room to curve.
  const boxGeo = new THREE.BoxGeometry(1, 1, 1, 3, 3, 3);
  const pos = boxGeo.attributes.position;
  const sx = 0.78 + rnd() * 0.4; // 0.78–1.18
  const sy = 0.62 + rnd() * 0.32; // 0.62–0.94 — slightly flatter chunk
  const sz = 0.72 + rnd() * 0.4; // 0.72–1.12
  // How far to pull the box toward an ellipsoid (0 = box, 1 = smooth oval).
  const roundAmt = 0.48 + rnd() * 0.22;
  const tmp = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    tmp.fromBufferAttribute(pos, i);
    // Unit-cube coords before squash — used for sphere blend.
    const ux = tmp.x;
    const uy = tmp.y;
    const uz = tmp.z;
    const len = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;

    // Lerp box point toward ellipsoid surface for visibly rounded corners.
    tmp.x = THREE.MathUtils.lerp(ux, ux / len, roundAmt) * sx;
    tmp.y = THREE.MathUtils.lerp(uy, uy / len, roundAmt) * sy;
    tmp.z = THREE.MathUtils.lerp(uz, uz / len, roundAmt) * sz;

    const noise = 1 + (rnd() - 0.5) * 0.16;
    tmp.multiplyScalar(noise);
    pos.setXYZ(i, tmp.x, tmp.y, tmp.z);
  }
  pos.needsUpdate = true;

  // Weld face-split verts so computeVertexNormals averages across edges.
  const geo = mergeVertices(boxGeo, 1e-4);
  boxGeo.dispose();
  const welded = geo.attributes.position;

  geo.computeBoundingBox();
  const box = geo.boundingBox!;
  const minY = box.min.y;
  const height = Math.max(box.max.y - minY, 1e-6);
  for (let i = 0; i < welded.count; i++) {
    tmp.fromBufferAttribute(welded, i);
    welded.setXYZ(i, tmp.x / height, (tmp.y - minY) / height, tmp.z / height);
  }
  welded.needsUpdate = true;

  // Cylindrical unwrap so the scratched gold map wraps the nugget.
  const uvs = geo.attributes.uv;
  for (let i = 0; i < welded.count; i++) {
    tmp.fromBufferAttribute(welded, i);
    const u = 0.5 + Math.atan2(tmp.x, tmp.z) / (Math.PI * 2);
    const v = THREE.MathUtils.clamp(tmp.y, 0, 1);
    uvs.setXY(i, u, v);
  }
  uvs.needsUpdate = true;

  geo.computeVertexNormals();
  return geo;
}

/** A few cached shape variants; instances mix them so no two clusters look stamped. */
const VARIANTS = 5;
let variantGeos: THREE.BufferGeometry[] | null = null;

function getVariantGeometries(): THREE.BufferGeometry[] {
  if (!variantGeos) {
    const rnd = mulberry32(0xc0ffee);
    variantGeos = Array.from({ length: VARIANTS }, () =>
      makeCrystalGeometry(rnd),
    );
  }
  return variantGeos;
}

// ---------- shared materials (one per palette, so glow edits hit every stroke) ----------

const materials = new Map<CrystalPaletteName, THREE.MeshStandardMaterial>();

/** Same scratched-gold leaf strip as rock ore flecks — solid metal for Citrine facets. */
async function loadGoldMaps(): Promise<{
  map: THREE.Texture;
  roughnessMap: THREE.Texture;
}> {
  const strip = await loadGoldStrip();
  return buildCrystalGoldMaps(strip);
}

let goldMapsPromise: Promise<{
  map: THREE.Texture;
  roughnessMap: THREE.Texture;
}> | null = null;

/** Attach scratched-gold leaf maps to the Citrine (metallic) material. */
export async function prepareCrystalGoldMaps(): Promise<void> {
  if (!goldMapsPromise) goldMapsPromise = loadGoldMaps();
  const { map, roughnessMap } = await goldMapsPromise;
  const mat = getMaterial("Citrine", 0);
  mat.map = map;
  mat.roughnessMap = roughnessMap;
  // Texture carries the gold; keep tint near-white so instance colors stay subtle.
  mat.color.set(0xffffff);
  mat.roughness = 0.38;
  mat.metalness = 1;
  mat.envMapIntensity = 3.2;
  mat.needsUpdate = true;
}

function getMaterial(
  name: CrystalPaletteName,
  glow: number,
): THREE.MeshStandardMaterial {
  let mat = materials.get(name);
  if (!mat) {
    const p = PALETTES[name];
    if (name === "Citrine") {
      // Opaque metallic gold (not transmissive quartz). Map applied via prepareCrystalGoldMaps.
      mat = new THREE.MeshStandardMaterial({
        color: 0xffe29b,
        metalness: 1,
        roughness: 0.38,
        envMapIntensity: 3.4,
        emissive: p.emissive,
        emissiveIntensity: glow,
      });
    } else {
      // Glass quartz: palette tint lives in per-instance colors + colored absorption —
      // base color stays white so the tint isn't multiplied into itself.
      mat = new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        metalness: 0,
        roughness: 0.05,
        // Partially transmissive: full transmission over the dark rock reads as flat
        // black glass. Keeping ~35% diffuse gives facet-by-facet shading (the milky,
        // translucent read of a real amethyst cluster) while the glass depth remains.
        transmission: 0.7,
        ior: 1.55,
        thickness: 0.4,
        attenuationColor: p.attenuation,
        attenuationDistance: 0.5,
        dispersion: 0.3, // chromatic fringing inside the glass — the "gem fire"
        iridescence: 0.4,
        iridescenceIOR: 1.3,
        clearcoat: 0.5,
        clearcoatRoughness: 0.12,
        specularIntensity: 1,
        emissive: p.emissive,
        emissiveIntensity: glow,
        envMapIntensity: 1.6,
      });
    }
    materials.set(name, mat);
  }
  mat.emissiveIntensity = glow;
  return mat;
}

/**
 * Clear quartz: the transparent, refractive companion material (one shared instance).
 * It lives on highlights — full transmission, near-zero roughness, strong dispersion —
 * so it reads as glass fire next to the tinted, absorbing crystals.
 */
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
      attenuationColor: 0xdfe8ff, // the faintest cool cast, like real rock crystal
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

/** Live glow slider: retint every material in place — no rebuild. */
export function setCrystalGlow(glow: number): void {
  for (const mat of materials.values()) mat.emissiveIntensity = glow;
  if (clearMaterial) clearMaterial.emissiveIntensity = glow * 0.35;
}

// ---------- per-stroke instance ----------

type CrystalKind = "main" | "shard" | "rubble";

/**
 * One crystal = its stable generative parameters. Everything derived (matrix, color,
 * visibility) is recomputed from these + the current settings, which is what makes every
 * slider live without recreating anything.
 */
interface CrystalInstance {
  variant: number;
  kind: CrystalKind;
  // where it sits on the stroke
  anchor: THREE.Vector3; // cluster's anchor-local surface point
  n: THREE.Vector3; // surface normal there
  t1: THREE.Vector3; // tangent frame
  t2: THREE.Vector3;
  birth: number; // stroke distance at which this crystal starts growing
  // culling ranks
  clusterRnd: number; // same for the whole cluster → density culling
  shardIndex: number; // 0..MAX_SHARDS-1 → shard-count culling
  shardCountRnd: number; // per-cluster variation of the shard count
  // stable per-crystal randoms (all 0..1)
  offAz: number; // azimuth of the offset from the cluster anchor
  offFrac: number; // offset radius, as a fraction of the cluster footprint
  heightBase: number; // kind-specific size, as a multiple of crystalSize
  jitterRnd: number; // feeds the sizeJitter slider
  widthRnd: number; // X squash relative to size
  depthRnd: number; // Z squash relative to size
  tiltScale: number; // kind-specific lean multiplier
  leanRnd: number; // lean magnitude
  leanAz: number; // lean azimuth (radians)
  spin: number; // rotation about own axis (radians)
  hueRnd: number;
  satRnd: number;
  lightRnd: number;
  clearRnd: number; // stable rank for the clearMix slider (below the mix → clear quartz)
  /** Scales how far the base is sunk along -normal (coverage embeds deeper). */
  sinkMul: number;
  // derived cache, rewritten by applySettings()
  visible: boolean;
  isClear: boolean;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  scale: THREE.Vector3;
  color: THREE.Color;
}

const GROW_WINDOW = 0.45; // stroke-distance span over which one crystal scales in
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _align = new THREE.Quaternion();
const _Y = new THREE.Vector3(0, 1, 0);
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _hsl = { h: 0, s: 0, l: 0 };
const _white = new THREE.Color(0xffffff);
const _clearTint = new THREE.Color();

/** Elastic-ish pop: overshoots ~8% then settles, like a crystal snapping into being. */
function easeOutBack(t: number): number {
  const c1 = 1.20158;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

function maxBirth(instances: CrystalInstance[]): number {
  let max = 0;
  for (const inst of instances) {
    if (inst.birth > max) max = inst.birth;
  }
  return max;
}

class CrystalStroke implements StrokeInstance {
  readonly group = new THREE.Group();

  /** Two mesh sets per variant: tinted palette crystals and clear refractive quartz.
   *  Every instance owns a slot in BOTH; the clearMix slider decides which one is live
   *  (the other stays zero-scaled) — so the mix is instant, nothing rebuilt. */
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
    scatterMode: "path" | "points" | "veins" = "path",
  ) {
    this.settings = { ...settings };
    const rnd = mulberry32(seed);
    const embedded = scatterMode === "points" || scatterMode === "veins";
    const instances =
      scatterMode === "points"
        ? this.scatterPoints(samples, rnd)
        : this.scatter(samples, rnd, embedded ? "embedded" : "vein");

    // Bucket instances per geometry variant → one tinted + one clear InstancedMesh each.
    this.byVariant = Array.from({ length: VARIANTS }, () => []);
    for (const inst of instances) this.byVariant[inst.variant].push(inst);

    const geos = getVariantGeometries();
    const tintedMat = getMaterial(settings.palette, settings.glow);
    const clearMat = getClearMaterial(settings.glow);
    const makeMesh = (
      v: number,
      mat: THREE.MeshStandardMaterial,
    ): THREE.InstancedMesh => {
      const list = this.byVariant[v];
      const mesh = new THREE.InstancedMesh(
        geos[v],
        mat,
        Math.max(list.length, 1),
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false; // grows over time; cheap enough to always draw
      for (let i = 0; i < list.length; i++) mesh.setMatrixAt(i, _zero);
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
      this.group.add(mesh);
      return mesh;
    };
    for (let v = 0; v < VARIANTS; v++) {
      this.tinted.push(makeMesh(v, tintedMat));
      this.clear.push(makeMesh(v, clearMat));
    }

    // Loop — Math.max(...arr) stack-overflows at ~120k args (dense coverage).
    this.total =
      scatterMode === "points"
        ? maxBirth(instances)
        : this.strokeLength(samples);
    this.applySettings(settings); // derive matrices/colors/visibility for the first time
  }

  // ----- generation: stable parameters only, at slider maxima -----

  private strokeLength(samples: SurfaceSample[]): number {
    let d = 0;
    for (let i = 1; i < samples.length; i++)
      d += samples[i].local.distanceTo(samples[i - 1].local);
    return d;
  }

  /** Walk the stroke and drop a crystal cluster at MAX density; the slider culls live. */
  private scatter(
    samples: SurfaceSample[],
    rnd: () => number,
    placement: "vein" | "embedded" = "vein",
  ): CrystalInstance[] {
    const out: CrystalInstance[] = [];
    const spacing = 1 / MAX_DENSITY;

    let travelled = 0;
    let nextAt = 0;
    for (let i = 0; i < samples.length; i++) {
      if (i > 0) travelled += samples[i].local.distanceTo(samples[i - 1].local);
      if (travelled < nextAt) continue;
      nextAt = travelled + spacing * (0.75 + rnd() * 0.5);
      this.cluster(out, samples[i], travelled, rnd, placement);
    }
    return out;
  }

  /**
   * One cluster per surface sample — used for random % coverage fills where samples
   * are disconnected points, not a painted path. Birth times are sequential so growth
   * animation still sweeps across the rock in a few seconds.
   *
   * Offsets stay tight: painted strokes can sprawl along a vein, but random fill must
   * stay glued to the face it was sampled from (wide tangent offsets read as floating).
   */
  private scatterPoints(
    samples: SurfaceSample[],
    rnd: () => number,
  ): CrystalInstance[] {
    const out: CrystalInstance[] = [];
    const birthStep = 0.06;
    for (let i = 0; i < samples.length; i++) {
      this.cluster(out, samples[i], i * birthStep, rnd, "embedded");
    }
    return out;
  }

  /** One cluster: a dominant point, MAX_SHARDS shard slots, and a dusting of rubble. */
  private cluster(
    out: CrystalInstance[],
    sample: SurfaceSample,
    dist: number,
    rnd: () => number,
    placement: "vein" | "embedded" = "vein",
  ): void {
    const n = sample.localNormal.clone().normalize();
    // Guard against degenerate normals so the tangent frame stays valid.
    if (n.lengthSq() < 1e-8) n.set(0, 1, 0);

    const t1 = new THREE.Vector3(1, 0, 0);
    if (Math.abs(n.x) > 0.9) t1.set(0, 1, 0);
    t1.cross(n).normalize();
    const t2 = new THREE.Vector3().crossVectors(n, t1);

    const clusterRnd = rnd();
    const shardCountRnd = rnd();
    // Embedded (coverage) clusters hug the face; vein (paint) clusters can sprawl.
    const offMul = placement === "embedded" ? 0.4 : 1;
    const sinkMul = placement === "embedded" ? 0.85 : 1;

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
        offFrac: offFrac * offMul,
        heightBase,
        jitterRnd: rnd(),
        widthRnd: rnd(),
        depthRnd: rnd(),
        tiltScale: tiltScale * (placement === "embedded" ? 0.55 : 1),
        leanRnd: rnd(),
        leanAz: rnd() * Math.PI * 2,
        spin: rnd() * Math.PI * 2,
        hueRnd: rnd(),
        satRnd: rnd(),
        lightRnd: rnd(),
        clearRnd: rnd(),
        sinkMul,
        visible: true,
        isClear: false,
        pos: new THREE.Vector3(),
        quat: new THREE.Quaternion(),
        scale: new THREE.Vector3(1, 1, 1),
        color: new THREE.Color(),
      });
    };

    // Dominant nugget — often medium, occasionally a clearly larger ore chunk.
    add(
      "main",
      -1,
      0.04 * rnd(),
      0.7 + Math.pow(rnd(), 0.55) * 1.1, // ~0.7–1.8, skewed toward bigger
      0.3,
      0,
    );
    // Shards — many small grains, a few mid/large pebbles (power curve).
    for (let k = 0; k < MAX_SHARDS; k++) {
      add(
        "shard",
        k,
        0.08 + rnd() * 0.32,
        0.1 + Math.pow(rnd(), 1.7) * 0.85, // ~0.1–0.95, mostly small
        0.55,
        0.05 + rnd() * 0.1,
      );
    }
    // Rubble — dense micro flecks for the fine end of the size mix.
    const rubble = 5 + Math.floor(rnd() * 4);
    for (let k = 0; k < rubble; k++) {
      add(
        "rubble",
        -1,
        0.1 + rnd() * 0.4,
        0.025 + rnd() * 0.07, // ~0.025–0.095
        0.7,
        0.08 + rnd() * 0.1,
      );
    }
  }

  // ----- live settings: re-derive everything in place -----

  applySettings(settings: unknown): void {
    const s = settings as CrystalSettings;
    this.settings = { ...s };
    const palette = PALETTES[s.palette];
    const tintedMat = getMaterial(s.palette, s.glow);
    const clearMat = getClearMaterial(s.glow);
    const footprint = s.crystalSize * s.spread;
    const densityFrac = s.clusterDensity / MAX_DENSITY;

    for (let v = 0; v < VARIANTS; v++) {
      const tMesh = this.tinted[v];
      const cMesh = this.clear[v];
      if (tMesh.material !== tintedMat) tMesh.material = tintedMat;
      if (cMesh.material !== clearMat) cMesh.material = clearMat;

      const list = this.byVariant[v];
      for (let i = 0; i < list.length; i++) {
        const inst = list[i];

        // Visibility: density culls whole clusters; the shards slider culls shard slots.
        const shardCap = Math.round(
          s.shards * (0.7 + inst.shardCountRnd * 0.6),
        );
        inst.visible =
          inst.clusterRnd <= densityFrac &&
          (inst.kind !== "shard" || inst.shardIndex < shardCap);

        // Clear-quartz mix: stable rank, so raising the slider converts the same
        // crystals every time instead of reshuffling.
        inst.isClear = inst.clearRnd < s.clearMix;

        // Size: near-isotropic nugget. sizeJitter at max spans ~0.2×–2.0×.
        const jitterMul =
          1 - s.sizeJitter * 0.8 + inst.jitterRnd * s.sizeJitter * 1.8;
        const size = inst.heightBase * s.crystalSize * jitterMul;
        const sx = size * (0.7 + inst.widthRnd * 0.55);
        const sy = size * (0.65 + inst.jitterRnd * 0.45);
        const sz = size * (0.7 + inst.depthRnd * 0.55);
        inst.scale.set(sx, sy, sz);

        // Lean direction: surface normal tipped around a stable azimuth.
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

        // Position: offset in the tangent plane, base sunk into the rock so nuggets look embedded.
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
          .addScaledVector(inst.n, -0.28 * sy * inst.sinkMul);

        if (s.palette === "Citrine") {
          // Material already carries gold reflectance; instance color only varies brightness.
          const v = 0.88 + inst.lightRnd * 0.14;
          inst.color.setRGB(
            v,
            v * (0.96 + inst.satRnd * 0.04),
            v * (0.82 + inst.hueRnd * 0.1),
          );
        } else {
          // Tint from the palette + this crystal's stable color randoms.
          inst.color.copy(palette.base);
          inst.color.getHSL(_hsl);
          inst.color.setHSL(
            (_hsl.h + (inst.hueRnd - 0.5) * palette.hueJitter + 1) % 1,
            THREE.MathUtils.clamp(_hsl.s * (1.15 + inst.satRnd * 0.35), 0, 1),
            THREE.MathUtils.clamp(_hsl.l * (0.8 + inst.lightRnd * 0.45), 0, 1),
          );
        }
        tMesh.setColorAt(i, inst.color);
        // Clear slot: near-white with the faintest palette memory, varied per crystal.
        _clearTint.copy(inst.color).lerp(_white, 0.82 + inst.lightRnd * 0.12);
        cMesh.setColorAt(i, _clearTint);
      }
      if (tMesh.instanceColor) tMesh.instanceColor.needsUpdate = true;
      if (cMesh.instanceColor) cMesh.instanceColor.needsUpdate = true;
    }

    // Re-pose every born instance with the new derived values.
    this.done = false;
    this.pose(true);
  }

  // ----- StrokeInstance -----

  update(dt: number, _time: number): void {
    if (this.done) return;
    this.grown += dt * this.settings.growthSpeed;
    this.pose(false);
  }

  finishGrowth(): void {
    this.grown = this.total + GROW_WINDOW + 1;
    this.pose(true);
  }

  /**
   * Recompose matrices for crystals inside the growth window; freeze once all are grown.
   * `force` recomposes every instance (settings changed → even settled ones moved, and a
   * crystal may have flipped between its tinted and clear slot).
   */
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
          continue; // still unborn — matrix stays zero
        }
        const k = t >= 1 ? 1 : easeOutBack(t);
        if (t < 1.2 || force) {
          // Crystals emerge slightly narrower than tall, then relax — reads as mineral growth.
          _s.set(
            inst.scale.x * k * (0.6 + 0.4 * k),
            inst.scale.y * k,
            inst.scale.z * k * (0.6 + 0.4 * k),
          );
          _m.compose(inst.pos, inst.quat, _s);
          on.setMatrixAt(i, _m);
          if (force) off.setMatrixAt(i, _zero); // it may have just switched buckets
          dirty = true;
          if (t < 1) allDone = false;
        }
      }
      if (dirty) {
        tMesh.instanceMatrix.needsUpdate = true;
        cMesh.instanceMatrix.needsUpdate = true;
      }
    }
    if (allDone) this.done = true;
  }

  dispose(): void {
    this.group.removeFromParent();
    // Instanced buffers only; geometry + materials are shared across strokes.
    for (const mesh of this.tinted) mesh.dispose();
    for (const mesh of this.clear) mesh.dispose();
  }
}

// ---------- the mode ----------

export const crystalMode: PaintMode<CrystalSettings> = {
  id: "Crystals",
  createStroke(samples, seed, settings): StrokeInstance {
    return new CrystalStroke(samples, seed, settings);
  },
};

/** Coverage fill: one crystal cluster per surface sample (veins + packed dots). */
export function createCoverageCrystalStroke(
  samples: SurfaceSample[],
  seed: number,
  settings: CrystalSettings,
): StrokeInstance {
  return new CrystalStroke(samples, seed, settings, "points");
}

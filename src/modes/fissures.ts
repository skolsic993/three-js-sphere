import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import {
  abs,
  attribute,
  float,
  mix,
  positionLocal,
  smoothstep,
  step,
  time,
  uniform,
  vec3,
} from "three/tsl";
import {
  mulberry32,
  type PaintMode,
  type StrokeInstance,
  type SurfaceSample,
} from "./mode";

/* eslint-disable @typescript-eslint/no-explicit-any */
// @types/three loses the node type of attribute() (returns AttributeNode<string>), which
// breaks the fluent TSL API — wrap through float()/vec3() converts to restore typing.
const attrFloat = (name: string) => float(attribute(name, "float") as any);
const attrVec3 = (name: string) => vec3(attribute(name, "vec3") as any);
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Molten fissures mode. A stroke tears a glowing crack into the surface: a ribbon of
 * white-hot core light that races along the painted path, flanked by dark basalt lips,
 * breathing with traveling heat pulses, shedding embers, and spilling flickering orange
 * light onto the surface around it.
 *
 * Anatomy of one stroke:
 *  - CORE ribbon      — surface-hugging strip whose color is a blackbody ramp driven by a
 *                       TSL node graph (pulse waves + flicker + a white flash at the
 *                       propagating crack front). Width is a shader uniform → live.
 *  - UNDERGLOW ribbon — the same geometry, ~3× wider, additive — the radiant spill that
 *                       "lights" the surface where point lights can't reach.
 *  - ROCK lips        — instanced basalt chunks along both edges (live-culled like the
 *                       crystal mode), giving the crack physical relief.
 *  - EMBERS           — a small CPU particle pool of glowing motes rising from the melt.
 *  - LIGHT SPILL      — up to 3 flickering point lights along the crack.
 *
 * Every slider is live: widths/heat/pulse are uniforms, rocks re-pose in place, embers and
 * lights read settings at update time. Nothing is rebuilt while dragging.
 */

export interface FissureSettings {
  width: number; // crack width (world units)
  heat: number; // core temperature/brightness multiplier
  pulseSpeed: number; // traveling heat-wave speed
  branchDensity: number; // side branches per world unit (live-culled up to MAX_BRANCHES)
  branchLength: number; // branch reach (world units, live-tapered up to MAX_BRANCH_LEN)
  emberRate: number; // embers per second per world unit of open crack
  rockDensity: number; // lip chunks per world unit (live-culled up to MAX_ROCKS)
  rockSize: number; // lip chunk size (world units)
  lightSpill: number; // flickering point-light intensity scale
  growthSpeed: number; // crack propagation speed (world units / second)
}

export const defaultFissureSettings: FissureSettings = {
  width: 0.055,
  heat: 1.5,
  pulseSpeed: 1,
  branchDensity: 4,
  branchLength: 0.24,
  emberRate: 26,
  rockDensity: 18,
  rockSize: 0.065,
  lightSpill: 1.2,
  growthSpeed: 2.6,
};

/** Rock slots are generated at this density; the slider culls, never rebuilds. */
export const MAX_ROCKS = 30;
/** Branches are generated at these maxima; the sliders cull/taper them in the shader. */
export const MAX_BRANCHES = 8;
export const MAX_BRANCH_LEN = 0.6;

const PATH_STEP = 0.025; // centerline resample step (world units)
const ROCK_GROW = 0.35; // stroke-distance window over which a lip chunk pops in
const MAX_EMBERS = 320; // particle pool per stroke
const SPILL_LIGHTS = 3;

// ---------- shared resources ----------

/** Flattened jagged basalt chunk, flat-shaded. Normalized to ~unit size, base at y=0. */
function makeRockGeometry(rnd: () => number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(1, 0.55, 0.7, 2, 1, 1).toNonIndexed();
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  // Jitter shared corners consistently: displace by a hash of the rounded position.
  const seen = new Map<string, [number, number, number]>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    let d = seen.get(key);
    if (!d) {
      d = [(rnd() - 0.5) * 0.45, (rnd() - 0.5) * 0.3, (rnd() - 0.5) * 0.4];
      seen.set(key, d);
    }
    pos.setXYZ(
      i,
      pos.getX(i) + d[0],
      pos.getY(i) * (0.7 + rnd() * 0.1) + d[1] * 0.5 + 0.25,
      pos.getZ(i) + d[2],
    );
  }
  geo.computeVertexNormals();
  return geo;
}

const ROCK_VARIANTS = 4;
let rockGeos: THREE.BufferGeometry[] | null = null;

function getRockGeometries(): THREE.BufferGeometry[] {
  if (!rockGeos) {
    const rnd = mulberry32(0xba5a17);
    rockGeos = Array.from({ length: ROCK_VARIANTS }, () =>
      makeRockGeometry(rnd),
    );
  }
  return rockGeos;
}

let rockMaterial: THREE.MeshStandardMaterial | null = null;

function getRockMaterial(): THREE.MeshStandardMaterial {
  if (!rockMaterial) {
    rockMaterial = new THREE.MeshStandardMaterial({
      color: 0x565056, // multiplied by per-instance charcoal tints → near-black basalt
      roughness: 0.95,
      metalness: 0.02,
      envMapIntensity: 0.15,
    });
  }
  return rockMaterial;
}

/** Shared additive material for the instanced ember quads. */
let emberMaterial: THREE.MeshBasicMaterial | null = null;

function getEmberMaterial(): THREE.MeshBasicMaterial {
  if (!emberMaterial) {
    emberMaterial = new THREE.MeshBasicMaterial({
      map: getEmberTexture(),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
  }
  return emberMaterial;
}

/** Soft round sprite for the ember points. */
let emberTexture: THREE.CanvasTexture | null = null;

function getEmberTexture(): THREE.CanvasTexture {
  if (!emberTexture) {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,220,180,0.8)");
    g.addColorStop(1, "rgba(255,120,40,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    emberTexture = new THREE.CanvasTexture(canvas);
  }
  return emberTexture;
}

// ---------- path + ribbon geometry ----------

interface PathPoint {
  pos: THREE.Vector3; // on-surface centerline point (anchor space)
  normal: THREE.Vector3;
  side: THREE.Vector3; // tangent × normal — the ribbon's across direction
  dist: number; // distance along the stroke (branches: origin dist + walked)
  walked: number; // distance walked from the branch origin (0 on the main crack)
  maxWalk: number; // this branch's full generated length (1 on the main crack)
  rank: number; // branch culling rank (0 on the main crack → never culled)
}

/** Resample the painted samples into an even centerline with a stable tangent frame. */
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
    pts.push({
      pos: samples[i].local.clone(),
      normal,
      side,
      dist: travelled,
      walked: 0,
      maxWalk: 1,
      rank: 0,
    });
  }
  return pts;
}

/**
 * Grow lightning-like side branches off the main crack. Each walks across the surface
 * from a point on the main path, veering and curving, at MAX length — the sliders then
 * cull whole branches (rank vs density) and pull the taper in (walked vs length), both
 * as shader uniforms, so branch controls are live with zero rebuilds.
 *
 * Surface following: positions re-project onto the sphere of radius |origin| around the
 * anchor origin — exact for the sphere canvas, a fair approximation for gentle meshes.
 */
function growBranches(main: PathPoint[], rnd: () => number): PathPoint[][] {
  const branches: PathPoint[][] = [];
  const spacing = 1 / MAX_BRANCHES;
  let next = spacing * (0.3 + rnd() * 0.5);
  let sideSign = rnd() < 0.5 ? 1 : -1;
  const q = new THREE.Quaternion();

  for (const origin of main) {
    if (origin.dist < next) continue;
    next = origin.dist + spacing * (0.7 + rnd() * 0.6);
    sideSign = -sideSign;

    const radius = origin.pos.length();
    const maxWalk = MAX_BRANCH_LEN * (0.45 + rnd() * 0.75);
    const curvature = (rnd() - 0.5) * 3; // radians of veer per unit walked
    const rank = rnd();

    // Launch direction: the main tangent swung 32°–72° to one side around the normal.
    const tangent = new THREE.Vector3().crossVectors(
      origin.normal,
      origin.side,
    );
    const dir = tangent
      .clone()
      .applyQuaternion(
        q.setFromAxisAngle(origin.normal, sideSign * (0.55 + rnd() * 0.7)),
      );

    const pts: PathPoint[] = [];
    const pos = origin.pos.clone();
    const normal = origin.normal.clone();
    for (let walked = 0; walked <= maxWalk; walked += PATH_STEP) {
      pts.push({
        pos: pos.clone(),
        normal: normal.clone(),
        side: new THREE.Vector3().crossVectors(dir, normal).normalize(),
        dist: origin.dist + walked,
        walked,
        maxWalk,
        rank,
      });
      // Step, re-project to the surface, re-orthogonalize and veer the direction.
      pos.addScaledVector(dir, PATH_STEP);
      if (radius > 1e-4) pos.setLength(radius);
      normal.copy(pos).normalize();
      dir.addScaledVector(normal, -dir.dot(normal)).normalize();
      dir.applyQuaternion(q.setFromAxisAngle(normal, curvature * PATH_STEP));
    }
    if (pts.length >= 2) branches.push(pts);
  }
  return branches;
}

/**
 * Ribbon geometry for the main crack + all its branches, in ONE indexed mesh. Vertices sit
 * at the CENTERLINE (the across displacement happens in the vertex shader via
 * `aSide × width-uniform × taper`), so crack width, branch density and branch length are
 * all live. The main crack's width jitter is pinched to a point at both stroke ends;
 * branches carry `aWalk`/`aMaxWalk`/`aRank` for the shader-side taper and culling.
 */
function buildRibbonGeometry(
  segments: PathPoint[][],
  total: number,
  rnd: () => number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const sides: number[] = [];
  const across: number[] = [];
  const dists: number[] = [];
  const jitters: number[] = [];
  const walks: number[] = [];
  const maxWalks: number[] = [];
  const ranks: number[] = [];
  const indices: number[] = [];

  for (const path of segments) {
    const base = positions.length / 3;
    const isBranch = path[0].rank > 0;
    let jit = 1;
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      // Smoothed random walk → organic width variation baked per point.
      jit = THREE.MathUtils.clamp(jit + (rnd() - 0.5) * 0.35, 0.6, 1.45);
      // Main crack: pinch to a TRUE zero-width point over the last 0.18 units at both
      // ends — a crack terminates in a spike, not a rounded cap. The 0.65 exponent keeps
      // the point long and needle-like instead of a linear wedge.
      // Branches: narrower than the main crack; their tip taper is dynamic (shader).
      let w = jit;
      if (isBranch) w *= 0.62;
      else
        w *= Math.pow(
          THREE.MathUtils.clamp(Math.min(p.dist, total - p.dist) / 0.18, 0, 1),
          0.65,
        );
      for (let k = 0; k < 2; k++) {
        positions.push(
          p.pos.x + p.normal.x * 0.006,
          p.pos.y + p.normal.y * 0.006,
          p.pos.z + p.normal.z * 0.006,
        );
        sides.push(p.side.x, p.side.y, p.side.z);
        across.push(k === 0 ? -1 : 1);
        dists.push(p.dist);
        jitters.push(w);
        walks.push(p.walked);
        maxWalks.push(p.maxWalk);
        ranks.push(p.rank);
      }
    }
    for (let i = 0; i < path.length - 1; i++) {
      const a = base + i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("aSide", new THREE.Float32BufferAttribute(sides, 3));
  geo.setAttribute("aAcross", new THREE.Float32BufferAttribute(across, 1));
  geo.setAttribute("aDist", new THREE.Float32BufferAttribute(dists, 1));
  geo.setAttribute("aJit", new THREE.Float32BufferAttribute(jitters, 1));
  geo.setAttribute("aWalk", new THREE.Float32BufferAttribute(walks, 1));
  geo.setAttribute("aMaxWalk", new THREE.Float32BufferAttribute(maxWalks, 1));
  geo.setAttribute("aRank", new THREE.Float32BufferAttribute(ranks, 1));
  geo.setIndex(indices);
  return geo;
}

// ---------- per-stroke rock instances ----------

interface RockInstance {
  variant: number;
  anchor: THREE.Vector3;
  n: THREE.Vector3;
  side: THREE.Vector3; // signed: which lip of the crack it sits on
  tangent: THREE.Vector3;
  birth: number;
  cullRnd: number; // density culling rank
  offRnd: number; // how far outside the crack edge
  yaw: number;
  sizeRnd: number;
  flatRnd: number; // height squash
  tint: number; // 0..1 charcoal variation
  visible: boolean;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  scale: THREE.Vector3;
}

const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _basis = new THREE.Matrix4();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _color = new THREE.Color();

function easeOutBack(t: number): number {
  const c1 = 1.20158;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

// ---------- ember particles ----------

interface Ember {
  alive: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  quat: THREE.Quaternion; // random fixed facing — reads as a spark, no billboarding needed
  size: number;
  life: number;
  maxLife: number;
  heat: number; // 0..1 — how white it starts
}

// ---------- the stroke ----------

class FissureStroke implements StrokeInstance {
  readonly group = new THREE.Group();

  private settings: FissureSettings;
  private path: PathPoint[]; // main crack only (lights, rocks)
  private allPts: PathPoint[]; // main + branches (ember spawning)
  private readonly total: number;
  private grown = 0;
  private rocksDone = false;

  // shader uniforms (live sliders)
  private uGrown = uniform(0);
  private uWidth = uniform(0.05);
  private uGlowWidth = uniform(0.16);
  private uHeat = uniform(1);
  private uPulse = uniform(1);
  private uBranchFrac = uniform(0.5); // branchDensity / MAX_BRANCHES
  private uLenFrac = uniform(0.4); // branchLength / MAX_BRANCH_LEN
  private uTotal = uniform(1); // main crack length, for the tip light fade

  private ribbonGeo!: THREE.BufferGeometry;
  private coreMat!: MeshBasicNodeMaterial;
  private underMat!: MeshBasicNodeMaterial;
  private rockMeshes: THREE.InstancedMesh[] = [];
  private rocksByVariant: RockInstance[][];

  private embers: Ember[] = [];
  private emberMesh: THREE.InstancedMesh;
  private emberSpawnDebt = 0;

  private lights: { light: THREE.PointLight; dist: number; phase: number }[] =
    [];

  constructor(
    samples: SurfaceSample[],
    seed: number,
    settings: FissureSettings,
  ) {
    this.settings = { ...settings };
    const rnd = mulberry32(seed);
    this.path = buildPath(samples);
    this.total = this.path.length ? this.path[this.path.length - 1].dist : 0;
    this.uTotal.value = Math.max(this.total, 1e-3);
    const branches = growBranches(this.path, rnd);
    this.allPts = [...this.path, ...branches.flat()];

    // ----- ribbons (one geometry: main + branches, two node materials) -----
    this.ribbonGeo = buildRibbonGeometry(
      [this.path, ...branches],
      this.total,
      rnd,
    );

    this.coreMat = new MeshBasicNodeMaterial();
    this.coreMat.transparent = true;
    this.coreMat.depthWrite = false;
    // Additive: where two fissures (or a branch and its parent) cross, their light SUMS
    // into a hotter junction instead of one crack's edge painting over the other.
    this.coreMat.blending = THREE.AdditiveBlending;
    this.buildCoreNodes(this.coreMat);
    const coreMesh = new THREE.Mesh(this.ribbonGeo, this.coreMat);
    coreMesh.renderOrder = 2;
    coreMesh.frustumCulled = false;

    this.underMat = new MeshBasicNodeMaterial();
    this.underMat.transparent = true;
    this.underMat.depthWrite = false;
    this.underMat.blending = THREE.AdditiveBlending;
    this.buildUnderglowNodes(this.underMat);
    const underMesh = new THREE.Mesh(this.ribbonGeo, this.underMat);
    underMesh.renderOrder = 1;
    underMesh.frustumCulled = false;

    this.group.add(underMesh, coreMesh);

    // ----- rock lips -----
    this.rocksByVariant = Array.from({ length: ROCK_VARIANTS }, () => []);
    this.scatterRocks(rnd);
    const geos = getRockGeometries();
    const rockMat = getRockMaterial();
    for (let v = 0; v < ROCK_VARIANTS; v++) {
      const list = this.rocksByVariant[v];
      const mesh = new THREE.InstancedMesh(
        geos[v],
        rockMat,
        Math.max(list.length, 1),
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      for (let i = 0; i < list.length; i++) {
        mesh.setMatrixAt(i, _zero);
        _color.setHSL(
          0.06 + list[i].tint * 0.02,
          0.08,
          0.045 + list[i].tint * 0.03,
        );
        mesh.setColorAt(i, _color);
      }
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.rockMeshes.push(mesh);
      this.group.add(mesh);
    }

    // ----- embers -----
    // Instanced quads, NOT Points: WebGPU point primitives are always 1px, so a
    // PointsMaterial ember would be invisible. Random fixed facings read fine as sparks.
    for (let i = 0; i < MAX_EMBERS; i++) {
      this.embers.push({
        alive: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        quat: new THREE.Quaternion(),
        size: 0.02,
        life: 0,
        maxLife: 1,
        heat: 0,
      });
    }
    this.emberMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      getEmberMaterial(),
      MAX_EMBERS,
    );
    for (let i = 0; i < MAX_EMBERS; i++) {
      this.emberMesh.setMatrixAt(i, _zero);
      this.emberMesh.setColorAt(i, _color.setRGB(0, 0, 0));
    }
    this.emberMesh.renderOrder = 3;
    this.emberMesh.frustumCulled = false;
    this.group.add(this.emberMesh);

    // ----- light spill -----
    const nLights = Math.min(
      SPILL_LIGHTS,
      Math.max(1, Math.round(this.total * 1.2)),
    );
    for (let i = 0; i < nLights; i++) {
      const f = nLights === 1 ? 0.5 : 0.12 + (0.76 * i) / (nLights - 1);
      const p = this.pathAt(this.total * f);
      const light = new THREE.PointLight(0xff7030, 0, 1.5, 2);
      light.position.copy(p.pos).addScaledVector(p.normal, 0.07);
      this.group.add(light);
      this.lights.push({ light, dist: this.total * f, phase: rnd() * 20 });
    }

    this.applySettings(settings);
  }

  /**
   * Branch culling + tip shaping, computed in the shader so the sliders stay live:
   *  - `sel` — 1 while a branch's rank is under the density fraction (main crack rank=0,
   *    so it always survives); culled branches collapse to zero width.
   *  - `taper` — pinches a branch to a point at `branchLength`, wherever the slider is.
   *  - `tip` — dims the LIGHT into the main crack's needle points, so the glow dies into
   *    the spike instead of haloing it into a rounded cap. Branches are exempt (their
   *    aDist can exceed the main length) — their own taper already cools their tips.
   */
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- inferred TSL node types
  private branchFactors() {
    const aWalk = attrFloat("aWalk");
    const aMaxWalk = attrFloat("aMaxWalk");
    const aRank = attrFloat("aRank");
    const aDist = attrFloat("aDist");
    const sel = step(aRank, this.uBranchFrac);
    const taper = float(1)
      .sub(aWalk.div(aMaxWalk.mul(this.uLenFrac).add(1e-4)))
      .clamp(0, 1)
      .pow(0.7);
    const isBranch = step(1e-5, aRank);
    const tip = mix(
      smoothstep(0.0, 0.16, aDist.min(this.uTotal.sub(aDist))),
      float(1),
      isBranch,
    );
    return { sel, taper, tip };
  }

  /** Blackbody-ish core: dark seam → deep red → orange → white-hot, pulsing along its length. */
  private buildCoreNodes(mat: MeshBasicNodeMaterial): void {
    const aAcross = attrFloat("aAcross");
    const aDist = attrFloat("aDist");
    const aJit = attrFloat("aJit");
    const aSide = attrVec3("aSide");
    const { sel, taper, tip } = this.branchFactors();

    mat.positionNode = positionLocal.add(
      aSide
        .mul(this.uWidth.mul(0.5).mul(aAcross).mul(aJit))
        .mul(taper.mul(sel)),
    );

    const openness = smoothstep(0.0, 0.1, this.uGrown.sub(aDist));
    const center = smoothstep(0.12, 1.0, abs(aAcross)).oneMinus();
    const pulse = aDist
      .mul(7)
      .sub(time.mul(this.uPulse.mul(2.6)))
      .sin()
      .mul(0.28)
      .add(0.72);
    const flicker = time.mul(9).add(aDist.mul(41)).sin().mul(0.08).add(0.94);
    // White flash at the racing crack front (also dimmed into the tips).
    const flash = smoothstep(0.0, 0.22, abs(this.uGrown.sub(aDist)))
      .oneMinus()
      .mul(1.6)
      .mul(tip);
    // Branches run cooler toward their tips; the main crack's light dies into its points.
    const heat = center
      .mul(pulse)
      .mul(flicker)
      .mul(this.uHeat)
      .mul(taper.mul(0.35).add(0.65))
      .mul(tip.mul(0.85).add(0.15))
      .add(flash);

    const cSeam = vec3(0.02, 0.004, 0.002);
    const cRed = vec3(1.1, 0.1, 0.01);
    const cOrange = vec3(2.6, 0.85, 0.1);
    const cWhite = vec3(4.6, 3.6, 2.4);
    let color = mix(cSeam, cRed, smoothstep(0.0, 0.55, heat));
    color = mix(color, cOrange, smoothstep(0.55, 1.15, heat));
    color = mix(color, cWhite, smoothstep(1.15, 2.1, heat));
    mat.colorNode = color;

    const edge = smoothstep(0.82, 1.0, abs(aAcross)).oneMinus();
    mat.opacityNode = openness.mul(edge).mul(sel);
  }

  /** The wide additive halo that paints radiant orange onto the surrounding surface. */
  private buildUnderglowNodes(mat: MeshBasicNodeMaterial): void {
    const aAcross = attrFloat("aAcross");
    const aDist = attrFloat("aDist");
    const aJit = attrFloat("aJit");
    const aSide = attrVec3("aSide");
    const { sel, taper, tip } = this.branchFactors();

    mat.positionNode = positionLocal.add(
      aSide
        .mul(this.uGlowWidth.mul(0.5).mul(aAcross).mul(aJit))
        .mul(taper.mul(sel)),
    );

    const openness = smoothstep(0.0, 0.18, this.uGrown.sub(aDist));
    const falloff = abs(aAcross).oneMinus().max(0).pow(1.6);
    const pulse = aDist
      .mul(7)
      .sub(time.mul(this.uPulse.mul(2.6)))
      .sin()
      .mul(0.22)
      .add(0.78);
    // The halo fades out entirely at the tips — a glow blob past the point would read as
    // a rounded end and undo the spike.
    const strength = falloff
      .mul(pulse)
      .mul(this.uHeat)
      .mul(taper.mul(0.5).add(0.5))
      .mul(tip)
      .mul(0.34);
    mat.colorNode = vec3(1.5, 0.38, 0.05).mul(strength);
    mat.opacityNode = openness.mul(sel);
  }

  // ----- rocks -----

  private scatterRocks(rnd: () => number): void {
    const step = 1 / MAX_ROCKS;
    let next = step * 0.5;
    let flip = 1;
    for (const p of this.path) {
      if (p.dist < next) continue;
      next = p.dist + step * (0.8 + rnd() * 0.4);
      flip = -flip;
      this.rocksByVariant[Math.floor(rnd() * ROCK_VARIANTS)].push({
        variant: 0, // (bucketed already; kept for symmetry)
        anchor: p.pos,
        n: p.normal,
        side: p.side.clone().multiplyScalar(flip),
        tangent: new THREE.Vector3().crossVectors(p.normal, p.side),
        birth: p.dist + rnd() * 0.08,
        cullRnd: rnd(),
        offRnd: rnd(),
        yaw: (rnd() - 0.5) * 0.9,
        sizeRnd: rnd(),
        flatRnd: 0.6 + rnd() * 0.6,
        tint: rnd(),
        visible: true,
        pos: new THREE.Vector3(),
        quat: new THREE.Quaternion(),
        scale: new THREE.Vector3(1, 1, 1),
      });
    }
  }

  // ----- live settings -----

  applySettings(settings: unknown): void {
    const s = settings as FissureSettings;
    this.settings = { ...s };
    this.uWidth.value = s.width;
    this.uGlowWidth.value = s.width * 3.4 + 0.05;
    this.uHeat.value = s.heat;
    this.uPulse.value = s.pulseSpeed;
    this.uBranchFrac.value = s.branchDensity / MAX_BRANCHES;
    this.uLenFrac.value = s.branchLength / MAX_BRANCH_LEN;

    const densityFrac = s.rockDensity / MAX_ROCKS;
    for (let v = 0; v < ROCK_VARIANTS; v++) {
      const list = this.rocksByVariant[v];
      for (const r of list) {
        r.visible = r.cullRnd <= densityFrac;
        const size = s.rockSize * (0.55 + r.sizeRnd * 0.9);
        r.scale.set(size, size * r.flatRnd, size * 0.8);
        // Sit just outside the crack edge, sunk well into the surface so only the top
        // ridge of each chunk breaks through — broken crust, not scattered pebbles.
        r.pos
          .copy(r.anchor)
          .addScaledVector(
            r.side,
            s.width * 0.55 + r.offRnd * s.width * 0.6 + size * 0.15,
          )
          .addScaledVector(r.n, -0.3 * size * r.flatRnd);
        // Long axis along the crack, random yaw, slight outward roll.
        _basis.makeBasis(
          r.tangent,
          r.n,
          new THREE.Vector3().crossVectors(r.tangent, r.n),
        );
        r.quat.setFromRotationMatrix(_basis);
        _q.setFromAxisAngle(r.n, r.yaw);
        r.quat.premultiply(_q);
        _q.setFromAxisAngle(r.tangent, (r.offRnd - 0.5) * 0.35);
        r.quat.premultiply(_q);
      }
    }
    this.rocksDone = false;
    this.poseRocks(true);
  }

  // ----- StrokeInstance -----

  update(dt: number, t: number): void {
    if (this.grown < this.total + ROCK_GROW + 0.4) {
      this.grown += dt * this.settings.growthSpeed;
      this.uGrown.value = this.grown;
    }
    if (!this.rocksDone) this.poseRocks(false);
    this.updateEmbers(dt);
    this.updateLights(t);
  }

  finishGrowth(): void {
    this.grown = this.total + ROCK_GROW + 1;
    this.uGrown.value = this.grown;
    this.poseRocks(true);
  }

  private poseRocks(force: boolean): void {
    let allDone = this.grown >= this.total + ROCK_GROW + 0.3;
    for (let v = 0; v < ROCK_VARIANTS; v++) {
      const list = this.rocksByVariant[v];
      const mesh = this.rockMeshes[v];
      let dirty = force;
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (!r.visible) {
          if (force) mesh.setMatrixAt(i, _zero);
          continue;
        }
        const t = (this.grown - r.birth) / ROCK_GROW;
        if (t <= 0) {
          if (force) mesh.setMatrixAt(i, _zero);
          allDone = false;
          continue;
        }
        const k = t >= 1 ? 1 : easeOutBack(t);
        if (t < 1.2 || force) {
          _s.copy(r.scale).multiplyScalar(k);
          _m.compose(r.pos, r.quat, _s);
          mesh.setMatrixAt(i, _m);
          dirty = true;
          if (t < 1) allDone = false;
        }
      }
      if (dirty) mesh.instanceMatrix.needsUpdate = true;
    }
    if (allDone) this.rocksDone = true;
  }

  // ----- embers -----

  private pathAt(dist: number): PathPoint {
    const i = THREE.MathUtils.clamp(
      Math.round(dist / PATH_STEP),
      0,
      this.path.length - 1,
    );
    return this.path[i];
  }

  private updateEmbers(dt: number): void {
    const open = Math.min(this.grown, this.total);
    if (open > 0.01) {
      this.emberSpawnDebt += dt * this.settings.emberRate * open;
      while (this.emberSpawnDebt >= 1) {
        this.emberSpawnDebt -= 1;
        const e = this.embers.find((x) => !x.alive);
        if (!e) break;
        // Spawn anywhere on the network — main crack or a LIVE part of a branch
        // (respecting the current density/length sliders and the growth front).
        const p = this.allPts[Math.floor(Math.random() * this.allPts.length)];
        if (
          p.dist > this.grown ||
          p.rank > this.settings.branchDensity / MAX_BRANCHES ||
          p.walked > p.maxWalk * (this.settings.branchLength / MAX_BRANCH_LEN)
        )
          continue;
        e.alive = true;
        e.pos
          .copy(p.pos)
          .addScaledVector(
            p.side,
            (Math.random() - 0.5) * this.settings.width * 0.7,
          )
          .addScaledVector(p.normal, 0.01);
        e.vel
          .copy(p.normal)
          .multiplyScalar(0.16 + Math.random() * 0.2)
          .addScaledVector(p.side, (Math.random() - 0.5) * 0.1);
        e.quat.setFromEuler(
          new THREE.Euler(
            Math.random() * Math.PI,
            Math.random() * Math.PI,
            Math.random() * Math.PI,
          ),
        );
        e.size = 0.016 + Math.random() * 0.02;
        e.maxLife = 0.8 + Math.random() * 1.4;
        e.life = e.maxLife;
        e.heat = Math.random();
      }
    }

    for (let i = 0; i < this.embers.length; i++) {
      const e = this.embers[i];
      if (!e.alive) continue;
      e.life -= dt;
      if (e.life <= 0) {
        e.alive = false;
        this.emberMesh.setMatrixAt(i, _zero);
        continue;
      }
      // Rise, slow down, wander.
      e.vel.multiplyScalar(1 - dt * 0.6);
      e.pos.addScaledVector(e.vel, dt);
      e.pos.x += Math.sin(e.life * 7 + i) * dt * 0.02;
      e.pos.z += Math.cos(e.life * 6 + i * 1.7) * dt * 0.02;

      const f = e.life / e.maxLife; // 1 → 0
      _s.setScalar(e.size * (0.5 + f * 0.5));
      _m.compose(e.pos, e.quat, _s);
      this.emberMesh.setMatrixAt(i, _m);
      const b = f * f * (0.9 + e.heat * 0.7); // brightness decay
      this.emberMesh.setColorAt(
        i,
        _color.setRGB(b * 1.5, b * (0.4 + e.heat * 0.5), b * 0.14),
      );
    }
    this.emberMesh.instanceMatrix.needsUpdate = true;
    if (this.emberMesh.instanceColor)
      this.emberMesh.instanceColor.needsUpdate = true;
  }

  private updateLights(t: number): void {
    for (const { light, dist, phase } of this.lights) {
      if (this.grown <= dist) {
        light.intensity = 0;
        continue;
      }
      const ignite = THREE.MathUtils.clamp((this.grown - dist) / 0.4, 0, 1);
      const flicker =
        0.78 +
        0.16 * Math.sin(t * 13 + phase) +
        0.06 * Math.sin(t * 31 + phase * 2.3);
      light.intensity = this.settings.lightSpill * 1.6 * ignite * flicker;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    // Ribbon geometry + node materials are per-stroke (their uniforms are).
    this.ribbonGeo.dispose();
    this.coreMat.dispose();
    this.underMat.dispose();
    this.emberMesh.geometry.dispose();
    this.emberMesh.dispose(); // material is shared
    // Rock geometries + material are shared across strokes — only drop instance buffers.
    for (const mesh of this.rockMeshes) mesh.dispose();
  }
}

// ---------- the mode ----------

export const fissureMode: PaintMode<FissureSettings> = {
  id: "Molten fissures",
  createStroke(samples, seed, settings): StrokeInstance {
    return new FissureStroke(samples, seed, settings);
  },
};

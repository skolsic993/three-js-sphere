import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { indexForRaycasts } from "./bvh";
import { SurfacePainter } from "./surfacePainter";
import {
  mulberry32,
  type StrokeInstance,
  type SurfaceSample,
} from "./modes/mode";
import {
  createCoverageCrystalStroke,
  crystalMode,
  defaultCrystalSettings,
  prepareCrystalGoldMaps,
  setCrystalGlow,
  type CrystalSettings,
} from "./modes/crystals";
import {
  createRockGeometry,
  createRockMaterial,
  loadRockTextures,
  type RockTextures,
} from "./rockGeometry";
import { createGoldFlecks } from "./goldFlecks";
import { sampleRockCoverageVeins } from "./crystalCoverage";
import { buildGui } from "./ui";

/** Scenery rocks around the canvas — not paint targets. */
interface CompanionSpec {
  seed: number;
  scale: number;
  detail: number;
  position: [number, number, number];
  rotation: [number, number, number];
}

/** Per-rock idle bob — base pose + desynchronized sine drift. */
interface RockFloat {
  object: THREE.Object3D;
  base: THREE.Vector3;
  ampY: number;
  ampXZ: number;
  freqY: number;
  freqXZ: number;
  phaseY: number;
  phaseXZ: number;
}

interface Stroke {
  samples: SurfaceSample[];
  index: number; // stable per-stroke id; combined with the global seed to vary each stroke
}

/** Everything the GUI edits. */
export interface AppSettings {
  drawMode: boolean;
  seed: number;
  exposure: number;
  envIntensity: number;
  backlight: number; // scales the kickers that stream light through the crystals
}

export class App {
  readonly settings: AppSettings = {
    drawMode: true,
    seed: 1,
    exposure: 1.1,
    envIntensity: 0.9,
    backlight: 1,
  };

  readonly crystal: CrystalSettings = { ...defaultCrystalSettings };

  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  private controls!: OrbitControls;
  private painter!: SurfacePainter;

  /** Main rock + companions + paint — shared bob root (no mouse tilt). */
  private floatRoot = new THREE.Group();
  /** Main specimen only (rock + flecks + paint) — set its initial pose here. */
  private mainRock = new THREE.Group();
  private rock!: THREE.Mesh;
  /** Shared across main + companions — one Physical draw state, shared maps. */
  private rockMaterial!: THREE.MeshPhysicalMaterial;
  private paintRoot = new THREE.Group(); // strokes parent here (child of mainRock)

  private strokes: Stroke[] = [];
  private live: StrokeInstance[] = [];
  private strokeCounter = 0;

  /**
   * Random surface fill on the main rock from `crystal.surfaceCoverage`.
   * One stroke per vein so seams grow independently; ignored by undo/clear.
   */
  private coverageStrokes: StrokeInstance[] = [];
  /** Rear fill light(s), scaled together by the Backlight slider. */
  private backLights: { light: THREE.DirectionalLight; base: number }[] = [];

  /** Independent subtle bob for main + each companion. */
  private floatingRocks: RockFloat[] = [];

  private lastTime = 0;
  private regrowPending: { mode: "instant" | "animate" } | null = null;
  private lastRegrowAt = 0;
  private regrowCost = 0;

  constructor(private container: HTMLElement) {}

  async start(): Promise<void> {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    // Coarse pointers (phones) stay at 1×; desktop caps at 1.5× to cut fill rate.
    const dprCap = matchMedia("(pointer: coarse)").matches ? 1 : 1.5;
    renderer.setPixelRatio(Math.min(devicePixelRatio, dprCap));
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = this.settings.exposure;
    this.container.appendChild(renderer.domElement);
    this.renderer = renderer;

    // Transparent canvas — page shows through; no sky dome / fog wash.
    this.scene.background = null;
    this.scene.fog = null;
    this.camera.position.set(25, 1.7, 5.6);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 9;
    this.controls.maxDistance = 9;
    this.controls.target.set(0, -0.1, 0);
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;

    this.setupEnvironment();
    this.setupLights();
    await prepareCrystalGoldMaps();
    setCrystalGlow(this.crystal.glow);
    await this.setupCanvasRock();

    this.painter = new SurfacePainter(
      renderer.domElement,
      this.camera,
      this.scene,
      () => [this.rock],
      this.mainRock,
    );
    this.painter.onStroke = (samples) => this.addStroke(samples);
    this.painter.onActiveChange = (active) => {
      this.controls.enabled = !active;
    };

    buildGui(this);
    this.applyModes();

    window.addEventListener("keydown", (e) => {
      if (e.repeat || e.target instanceof HTMLInputElement) return;
      if (e.key.toLowerCase() === "d") this.toggleMode();
    });

    window.addEventListener("resize", this.onResize);
    this.onResize();

    renderer.setAnimationLoop((t) => this.tick(t));
  }

  // ---------- environment: a sunny outdoor sky captured into a PMREM env map ----------

  /**
   * Daylight reflections for metal gold: a bright sun disk, open blue sky, and a warm
   * ground bounce — so scratched-gold facets pick up outdoor speculars instead of studio strips.
   */
  private setupEnvironment(): void {
    const env = new THREE.Scene();
    const geo = new THREE.PlaneGeometry(1, 1);

    const panel = (
      color: number,
      intensity: number,
      w: number,
      h: number,
      pos: [number, number, number],
    ): void => {
      const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
      mat.color.set(color).multiplyScalar(intensity); // HDR: >1 colors become light sources
      const m = new THREE.Mesh(geo, mat);
      m.scale.set(w, h, 1);
      m.position.set(...pos);
      m.lookAt(0, 0, 0);
      env.add(m);
    };

    panel(0xfff4d6, 55, 1.2, 1.2, [4, 9, 3]); // sun disk
    panel(0xffe8b8, 18, 3.5, 2.5, [2, 8, 1]); // sun haze
    panel(0xa8c8f0, 4, 14, 8, [0, 6, -4]); // open blue sky dome
    panel(0xd8e8ff, 2.5, 10, 5, [-5, 4, 2]); // cool sky fill, camera-left
    panel(0xffe2b0, 3, 8, 4, [5, 2, 4]); // warm late-day rim
    panel(0xc4a882, 1.8, 12, 12, [0, -6, 0]); // sandy ground bounce

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(env, 0.04).texture;
    this.scene.environmentIntensity = this.settings.envIntensity;
    pmrem.dispose();
    geo.dispose();
  }

  /**
   * Outdoor sun key + soft sky fill — warm daylight on the charcoal rock.
   * Four lights only (hemi + spot + fill + gold key); no shadow maps.
   * No floor or sky mesh: the canvas stays fully transparent for compositing.
   */
  private setupLights(): void {
    // Whisper hemi + dark dirt ground — silhouette readable, far side stays charcoal.
    const hemi = new THREE.HemisphereLight(0xb8d4f5, 0x3a2e22, 0.05);

    const key = new THREE.SpotLight(0xfff2d8, 70, 0, Math.PI / 3.8, 0.45, 1.4);
    key.position.set(4.2, 7.2, 3.2);
    key.target.position.set(0, 0, 0);

    // Single cool fill (replaces former fill + topRight + under).
    const fill = new THREE.DirectionalLight(0xc5d8f0, 0.14);
    fill.position.set(-3.5, 4.5, 2.5);

    // Rear rim — Backlight slider scales this for crystal transmission.
    const back = new THREE.DirectionalLight(0xd0e4ff, 0.12);
    back.position.set(-2.5, 4, -5);

    const goldKick = new THREE.DirectionalLight(0xffe2a8, 4.2);
    goldKick.position.set(3, 8, 2);

    this.backLights = [{ light: back, base: 0.12 }];

    this.scene.add(hemi, key, key.target, fill, back, goldKick);
  }

  /** The canvas itself: a jagged dark rock with Poly Haven PBR maps — quiet stage for crystals.
   *  Displacement is baked into the mesh so paint raycasts match the visible surface. */
  private async setupCanvasRock(): Promise<void> {
    const textures = await loadRockTextures(
      this.renderer.capabilities.getMaxAnisotropy(),
    );
    const geo = createRockGeometry(textures.displacementMap);
    this.rockMaterial = createRockMaterial(textures);

    this.rock = new THREE.Mesh(geo, this.rockMaterial);

    const flecks = createGoldFlecks(geo, { veinCount: 10, seed: 0x601d });
    this.mainRock.add(this.rock, flecks, this.paintRoot);

    // Upright teardrop; gouge is on local +X, facing the camera at (+X, +Z).
    this.mainRock.position.set(0, 0, 0);
    this.mainRock.rotation.set(1.28, 0.26, -0.06);
    // Slightly calmer bob than companions — paint anchor rides along with the group.
    this.registerRockFloat(this.mainRock, 0x7a1, { calm: true });

    this.floatRoot.add(this.mainRock);
    this.addCompanionRocks(textures);
    this.scene.add(this.floatRoot);
    // Only the canvas rock is paintable — companions are scenery.
    indexForRaycasts(this.rock);

    // Bare rock first; gold coverage grows in on the next frames (same as ▶ Replay).
    this.rebuildMainRockCoverage(true);
  }

  /**
   * Fill the main rock with crystal veins + packed dots covering `surfaceCoverage`
   * of the surface (0..1). Parent under the rock mesh so anchors match companions.
   */
  rebuildMainRockCoverage(animate: boolean): void {
    for (const s of this.coverageStrokes) {
      s.group.removeFromParent();
      s.dispose();
    }
    this.coverageStrokes = [];

    const coverage = THREE.MathUtils.clamp(this.crystal.surfaceCoverage, 0, 1);
    if (coverage <= 0 || !this.rock) return;

    const veins = sampleRockCoverageVeins(this.rock.geometry, {
      coverage,
      seed: this.effectiveSeed(0xc0ff),
      crystalSize: this.crystal.crystalSize,
      spread: this.crystal.spread,
    });
    const samples = veins.flat();
    if (samples.length === 0) return;

    // Density locked at max so the coverage % alone controls fill amount.
    const stroke = createCoverageCrystalStroke(
      samples,
      this.effectiveSeed(0xc0a1),
      {
        ...this.crystal,
        clusterDensity: 16,
      },
    );
    // Same parenting as companion scenery — rock-local = sample-local.
    this.rock.add(stroke.group);
    this.coverageStrokes.push(stroke);
    if (!animate) stroke.finishGrowth();
  }

  /**
   * Monorepo/API entry: set how much of the rock is randomly crystal-covered (0..1).
   * Example: `app.setSurfaceCoverage(0.65)` ≈ 65% fill.
   */
  setSurfaceCoverage(coverage: number): void {
    this.crystal.surfaceCoverage = THREE.MathUtils.clamp(coverage, 0, 1);
    this.rebuildMainRockCoverage(false);
  }

  /**
   * A few similar-sized satellite rocks around the main specimen — same charcoal
   * material, no gold or crystals, so the centerpiece stays the only mineral.
   */
  private addCompanionRocks(textures: RockTextures): void {
    const companions: CompanionSpec[] = [
      // Camera is at (+X, +Z); screen-right is −Z, screen-left is +Z, up is +Y.
      {
        seed: 11.3,
        scale: 0.18,
        detail: 4,
        position: [0.25, 1.55, 1.75],
        rotation: [0.35, 1.1, -0.2],
      },
      {
        seed: 22.7,
        scale: 0.16,
        detail: 4,
        position: [0.35, 1.45, -1.7],
        rotation: [-0.4, 0.6, 0.5],
      },
      {
        seed: 33.1,
        scale: 0.17,
        detail: 4,
        position: [0.45, 0.1, -2.15],
        rotation: [0.6, -0.8, 0.15],
      },
      {
        seed: 88.2,
        scale: 0.19,
        detail: 4,
        position: [0.3, -1.5, -1.55],
        rotation: [0.25, -0.5, 0.8],
      },
      {
        seed: 91.6,
        scale: 0.16,
        detail: 4,
        position: [0.2, -1.9, 0.15],
        rotation: [-0.7, 1.0, -0.3],
      },
      {
        seed: 44.9,
        scale: 0.18,
        detail: 4,
        position: [-0.15, -1.55, 1.6],
        rotation: [0.9, 0.3, -0.5],
      },
    ];

    for (const spec of companions) {
      const geo = createRockGeometry(textures.displacementMap, {
        detail: spec.detail,
        scale: spec.scale,
        seed: spec.seed,
      });
      const mesh = new THREE.Mesh(geo, this.rockMaterial);
      mesh.position.set(...spec.position);
      mesh.rotation.set(...spec.rotation);
      mesh.raycast = () => {}; // never a paint target
      this.floatRoot.add(mesh);
      this.registerRockFloat(mesh, Math.floor(spec.seed * 1000));
    }
  }

  /**
   * Snapshot a rock's rest pose and assign a seeded, desynchronized bob.
   * `calm` keeps the main specimen gentler than the scenery satellites.
   */
  private registerRockFloat(
    object: THREE.Object3D,
    seed: number,
    opts: { calm?: boolean } = {},
  ): void {
    const rng = mulberry32(seed >>> 0);
    const calm = opts.calm === true;
    this.floatingRocks.push({
      object,
      base: object.position.clone(),
      ampY: calm ? 0.025 + rng() * 0.01 : 0.03 + rng() * 0.015,
      ampXZ: calm ? 0.008 + rng() * 0.004 : 0.01 + rng() * 0.005,
      freqY: 0.35 + rng() * 0.3,
      freqXZ: 0.25 + rng() * 0.25,
      phaseY: rng() * Math.PI * 2,
      phaseXZ: rng() * Math.PI * 2,
    });
  }

  // ---------- strokes ----------

  addStroke(samples: SurfaceSample[]): void {
    const stroke: Stroke = {
      samples,
      index: this.strokeCounter++,
    };
    this.strokes.push(stroke);
    this.buildStroke(stroke, true);
  }

  private buildStroke(stroke: Stroke, animate: boolean): void {
    const seed = this.effectiveSeed(stroke.index);
    const instance = crystalMode.createStroke(stroke.samples, seed, {
      ...this.crystal,
    });
    this.paintRoot.add(instance.group);
    this.live.push(instance);
    if (!animate) instance.finishGrowth();
  }

  private regrow(animate: boolean): void {
    for (const s of this.live) s.dispose();
    this.live = [];
    for (const stroke of this.strokes) this.buildStroke(stroke, animate);
  }

  /**
   * Ask for a rebuild. Requests are coalesced and throttled in the tick (slider drags fire
   * onChange dozens of times a second). 'instant' snaps to fully grown; 'animate' replays
   * the crystal growth.
   */
  scheduleRegrow(mode: "instant" | "animate"): void {
    if (this.regrowPending?.mode === "animate") return; // an animate request always wins
    this.regrowPending = { mode };
  }

  undoLast(): void {
    this.strokes.pop();
    const s = this.live.pop();
    s?.dispose();
  }

  clearAll(): void {
    for (const s of this.live) s.dispose();
    this.live = [];
    this.strokes = [];
    this.regrowPending = null;
  }

  /** Mix the global seed with a stroke's stable id so strokes stay distinct but reseed together. */
  private effectiveSeed(index: number): number {
    return ((this.settings.seed * 2654435761) ^ (index * 40503 + 1)) >>> 0;
  }

  // ---------- live (no-rebuild) setting paths ----------

  /**
   * Push current crystal settings into live strokes IN PLACE — matrices and colors update
   * on the existing objects, nothing is recreated.
   */
  updateCrystalSettings(): void {
    const settings = { ...this.crystal };
    for (const s of this.live) s.applySettings?.(settings);
    // Keep the random fill in sync with crystal look, but density stays max so
    // surfaceCoverage remains the only fill-amount control for those strokes.
    const coverageSettings = { ...this.crystal, clusterDensity: 16 };
    for (const s of this.coverageStrokes) s.applySettings?.(coverageSettings);
  }

  /** Reseed painted strokes and the random surface fill together. */
  reseedAll(mode: "instant" | "animate"): void {
    this.scheduleRegrow(mode);
    this.rebuildMainRockCoverage(mode === "animate");
  }

  setGlow(v: number): void {
    this.crystal.glow = v;
    setCrystalGlow(v);
  }

  setExposure(v: number): void {
    this.settings.exposure = v;
    this.renderer.toneMappingExposure = v;
  }

  setEnvIntensity(v: number): void {
    this.settings.envIntensity = v;
    this.scene.environmentIntensity = v;
  }

  /** Backlight slider: scales the rear rig — how hard light streams through the crystals. */
  setBacklight(v: number): void {
    this.settings.backlight = v;
    for (const { light, base } of this.backLights) light.intensity = base * v;
  }

  // ---------- paint / orbit ----------

  toggleMode(): void {
    this.settings.drawMode = !this.settings.drawMode;
    this.applyModes();
  }

  applyModes(): void {
    const draw = this.settings.drawMode;
    this.painter.setEnabled(draw);
    this.controls.enableRotate = !draw;
    document.body.classList.toggle("draw", draw);
    document.body.classList.toggle("orbit", !draw);
  }

  // ---------- frame loop ----------

  private onResize = (): void => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  private tick(time: number): void {
    const dt = Math.min((time - this.lastTime) / 1000, 0.05);
    this.lastTime = time;
    const tSec = time / 1000;

    if (this.regrowPending) {
      // Adaptive throttle: the heavier the last rebuild, the longer we wait before the
      // next one, so slider drags stay smooth whatever the scene costs.
      const now = performance.now();
      const interval =
        this.regrowPending.mode === "animate"
          ? 0
          : THREE.MathUtils.clamp(this.regrowCost * 3, 60, 400);
      if (now - this.lastRegrowAt >= interval) {
        const req = this.regrowPending;
        this.regrowPending = null;
        const t0 = performance.now();
        this.regrow(req.mode === "animate");
        this.regrowCost = performance.now() - t0;
        this.lastRegrowAt = performance.now();
      }
    }

    this.controls.update();
    this.painter.update(dt);
    for (const s of this.live) s.update(dt, tSec);
    for (const s of this.coverageStrokes) s.update(dt, tSec);

    // Per-rock idle float — independent phase/freq so they don't bob in sync.
    for (const f of this.floatingRocks) {
      f.object.position.x =
        f.base.x + Math.sin(tSec * f.freqXZ + f.phaseXZ) * f.ampXZ;
      f.object.position.y =
        f.base.y + Math.sin(tSec * f.freqY + f.phaseY) * f.ampY;
      f.object.position.z =
        f.base.z + Math.cos(tSec * f.freqXZ + f.phaseXZ * 1.3) * f.ampXZ;
    }

    this.renderer.render(this.scene, this.camera);
  }
}

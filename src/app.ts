import * as THREE from "three/webgpu";
import { float, pass, screenUV, smoothstep, vec2, vec4 } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { indexForRaycasts } from "./bvh";
import { SurfacePainter } from "./surfacePainter";
import type { PaintMode, StrokeInstance, SurfaceSample } from "./modes/mode";
import { mulberry32 } from "./modes/mode";
import {
  createCoverageCrystalStroke,
  crystalMode,
  defaultCrystalSettings,
  prepareCrystalGoldMaps,
  setCrystalGlow,
  type CrystalSettings,
} from "./modes/crystals";
import {
  defaultFissureSettings,
  fissureMode,
  type FissureSettings,
} from "./modes/fissures";
import {
  auroraMode,
  defaultAuroraSettings,
  type AuroraSettings,
} from "./modes/aurora";
import { defaultReefSettings, reefMode, type ReefSettings } from "./modes/reef";
import {
  createRockGeometry,
  createRockMaterial,
  loadRockTextures,
  type RockTextures,
} from "./rockGeometry";
import { createGoldFlecks } from "./goldFlecks";
import { sampleRockCoverageVeins } from "./crystalCoverage";
import { buildGui } from "./ui";

export type ModeName =
  | "Crystals"
  | "Molten fissures"
  | "Aurora silk"
  | "Bioluminescent reef";

const GROUND_Y = -2.05; // the floor the rock floats above

/** Scenery rocks around the canvas — not paint targets. */
interface CompanionSpec {
  seed: number;
  scale: number;
  detail: number;
  position: [number, number, number];
  rotation: [number, number, number];
  /** How many crystal clusters to seed on this rock. */
  crystalClusters: number;
  flecks: number;
}

interface Stroke {
  samples: SurfaceSample[];
  index: number; // stable per-stroke id; combined with the global seed to vary each stroke
  mode: ModeName; // which painting mode authored it (strokes rebuild through their own mode)
}

/** Everything the GUI edits. Mode-specific settings live in their own sub-objects. */
export interface AppSettings {
  mode: ModeName;
  drawMode: boolean;
  seed: number;
  exposure: number;
  envIntensity: number;
  backlight: number; // scales the kickers that stream light through the crystals
  bloomStrength: number;
  bloomThreshold: number;
}

export class App {
  readonly settings: AppSettings = {
    mode: "Crystals",
    drawMode: true,
    seed: 1,
    exposure: 1.1,
    envIntensity: 0.9,
    backlight: 1,
    bloomStrength: 0.4,
    bloomThreshold: 0.75,
  };

  readonly crystal: CrystalSettings = { ...defaultCrystalSettings };
  readonly fissure: FissureSettings = { ...defaultFissureSettings };
  readonly aurora: AuroraSettings = { ...defaultAuroraSettings };
  readonly reef: ReefSettings = { ...defaultReefSettings };

  /** Registry of painting modes — new modes plug in here. */
  private modes: Record<ModeName, PaintMode<unknown>> = {
    Crystals: crystalMode as PaintMode<unknown>,
    "Molten fissures": fissureMode as PaintMode<unknown>,
    "Aurora silk": auroraMode as PaintMode<unknown>,
    "Bioluminescent reef": reefMode as PaintMode<unknown>,
  };

  /** Snapshot of the settings object a given mode consumes. */
  private settingsFor(mode: ModeName): unknown {
    switch (mode) {
      case "Crystals":
        return { ...this.crystal };
      case "Molten fissures":
        return { ...this.fissure };
      case "Aurora silk":
        return { ...this.aurora };
      case "Bioluminescent reef":
        return { ...this.reef };
    }
  }

  private renderer!: THREE.WebGPURenderer;
  private post!: THREE.RenderPipeline;
  private bloomNode!: ReturnType<typeof bloom>;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  private controls!: OrbitControls;
  private painter!: SurfacePainter;

  /** The floating canvas: main rock + companions + paint — tilts together with the mouse. */
  private floatRoot = new THREE.Group();
  /** Main specimen only (rock + flecks + paint) — set its initial pose here. */
  private mainRock = new THREE.Group();
  private rock!: THREE.Mesh;
  private paintRoot = new THREE.Group(); // strokes parent here (child of mainRock)

  private strokes: Stroke[] = [];
  private live: StrokeInstance[] = [];
  private strokeCounter = 0;

  /** Initial crystals on companion rocks — updated each frame, ignored by undo/clear. */
  private sceneryStrokes: StrokeInstance[] = [];
  /**
   * Random surface fill on the main rock from `crystal.surfaceCoverage`.
   * One stroke per vein so seams grow independently; ignored by undo/clear.
   */
  private coverageStrokes: StrokeInstance[] = [];
  /** The backlight/kicker pair, scaled together by the Backlight slider. */
  private backLights: { light: THREE.DirectionalLight; base: number }[] = [];

  /** Mouse-driven tilt: target from pointer position, smoothed onto floatRoot each frame. */
  private tiltTarget = new THREE.Vector2(0, 0);

  private hud = document.getElementById("hud")!;
  private lastTime = 0;
  private hovering = false;
  private toastTimer = 0;
  private regrowPending: { mode: "instant" | "animate" } | null = null;
  private lastRegrowAt = 0;
  private regrowCost = 0;

  constructor(private container: HTMLElement) {}

  async start(): Promise<void> {
    const renderer = new THREE.WebGPURenderer({ antialias: true, alpha: true });
    await renderer.init();
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = this.settings.exposure;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(renderer.domElement);
    this.renderer = renderer;

    // Transparent canvas — page shows through; no sky dome / fog wash.
    this.scene.background = null;
    this.scene.fog = null;
    this.camera.position.set(25, 1.7, 5.6);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1;
    this.controls.maxDistance = 13;
    this.controls.target.set(0, -0.1, 0);
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;

    this.setupEnvironment();
    this.setupLights();
    await prepareCrystalGoldMaps();
    setCrystalGlow(this.crystal.glow);
    await this.setupCanvasRock();
    this.setupPost();

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
    this.painter.onHoverChange = (over) => {
      this.hovering = over;
      this.updateHud();
    };

    buildGui(this);
    this.applyModes();

    document
      .getElementById("modeBtn")!
      .addEventListener("click", () => this.toggleMode());
    window.addEventListener("keydown", (e) => {
      if (e.repeat || e.target instanceof HTMLInputElement) return;
      if (e.key.toLowerCase() === "d") this.toggleMode();
    });

    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("resize", this.onResize);
    this.onResize();

    renderer.setAnimationLoop((t) => this.tick(t));
  }

  /** Map pointer to a gentle tilt target — rocks follow the mouse; idle when it stops. */
  private onPointerMove = (e: PointerEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    // Horizontal mouse → yaw; vertical → pitch — kept small so the set barely leans.
    this.tiltTarget.set(ny * 0.06, nx * 0.01);
  };

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
   * No floor or sky mesh: the canvas stays fully transparent for compositing.
   */
  private setupLights(): void {
    // Low hemi + dark dirt ground so the shadow side isn't washed by sandy bounce.
    const hemi = new THREE.HemisphereLight(0xb8d4f5, 0x3a2e22, 0.08);

    const key = new THREE.SpotLight(0xfff2d8, 70, 0, Math.PI / 3.8, 0.45, 1.4);
    key.position.set(4.2, 7.2, 3.2);
    key.target.position.set(0, 0, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 24;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 4;

    const fill = new THREE.DirectionalLight(0xc5d8f0, 0.18);
    fill.position.set(-3.5, 4, 3.5);

    // Thin rim only — enough shape on the back, not a second key.
    const back = new THREE.DirectionalLight(0xd0e4ff, 0.32);
    back.position.set(-2.5, 4, -5);
    const kick = new THREE.DirectionalLight(0xffe0b0, 0.28);
    kick.position.set(5, 2, -2.5);
    const goldKick = new THREE.DirectionalLight(0xffe2a8, 4.2);
    goldKick.position.set(3, 8, 2);

    this.backLights = [
      { light: back, base: 0.32 },
      { light: kick, base: 0.28 },
    ];

    // Soft bounce from below — kept low so the underside stays near-black.
    const under = new THREE.PointLight(0xe8c898, 0.05, 7, 1.6);
    under.position.set(0, GROUND_Y + 0.35, 0);

    this.scene.add(hemi, key, key.target, fill, back, kick, goldKick, under);
  }

  /** The canvas itself: a jagged dark rock with Poly Haven PBR maps — quiet stage for crystals.
   *  Displacement is baked into the mesh so paint raycasts match the visible surface. */
  private async setupCanvasRock(): Promise<void> {
    const textures = await loadRockTextures(
      (
        this.renderer.backend as {
          capabilities?: { getMaxAnisotropy?: () => number };
        }
      ).capabilities?.getMaxAnisotropy?.() ?? 16,
    );
    const geo = createRockGeometry(textures.displacementMap);
    const mat = createRockMaterial(textures);

    this.rock = new THREE.Mesh(geo, mat);
    this.rock.castShadow = true;
    this.rock.receiveShadow = true;

    const flecks = createGoldFlecks(geo, { veinCount: 10, seed: 0x601d });
    this.mainRock.add(this.rock, flecks, this.paintRoot);

    // Upright teardrop; gouge is on local +X, facing the camera at (+X, +Z).
    this.mainRock.position.set(0, 0, 0);
    this.mainRock.rotation.set(1.28, 0.26, -0.06);

    this.floatRoot.add(this.mainRock);
    this.addCompanionRocks(textures);
    this.scene.add(this.floatRoot);
    // Only the canvas rock is paintable — companions are scenery.
    indexForRaycasts(this.rock);

    // Percentage fill before any painting — same dial a host monorepo can set.
    this.rebuildMainRockCoverage(false);
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
    // Same parenting as companion scenery crystals — rock-local = sample-local.
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
        crystalClusters: 0,
        flecks: 0,
      },
      {
        seed: 22.7,
        scale: 0.16,
        detail: 4,
        position: [0.35, 1.45, -1.7],
        rotation: [-0.4, 0.6, 0.5],
        crystalClusters: 0,
        flecks: 0,
      },
      {
        seed: 33.1,
        scale: 0.17,
        detail: 4,
        position: [0.45, 0.1, -2.15],
        rotation: [0.6, -0.8, 0.15],
        crystalClusters: 0,
        flecks: 0,
      },
      {
        seed: 88.2,
        scale: 0.19,
        detail: 4,
        position: [0.3, -1.5, -1.55],
        rotation: [0.25, -0.5, 0.8],
        crystalClusters: 0,
        flecks: 0,
      },
      {
        seed: 91.6,
        scale: 0.16,
        detail: 4,
        position: [0.2, -1.9, 0.15],
        rotation: [-0.7, 1.0, -0.3],
        crystalClusters: 0,
        flecks: 0,
      },
      {
        seed: 44.9,
        scale: 0.18,
        detail: 4,
        position: [-0.15, -1.55, 1.6],
        rotation: [0.9, 0.3, -0.5],
        crystalClusters: 0,
        flecks: 0,
      },
    ];

    const scenerySettings: CrystalSettings = {
      ...defaultCrystalSettings,
      crystalSize: 0.05,
      clusterDensity: 8,
      shards: 5,
      spread: 1.8,
      glow: 0,
    };

    for (const spec of companions) {
      const geo = createRockGeometry(textures.displacementMap, {
        detail: spec.detail,
        scale: spec.scale,
        seed: spec.seed,
      });
      // Share maps; each mesh needs its own material instance for safe disposal later.
      const mat = createRockMaterial(textures);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(...spec.position);
      mesh.rotation.set(...spec.rotation);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.raycast = () => {}; // never a paint target

      if (spec.flecks > 0) {
        mesh.add(
          createGoldFlecks(geo, {
            veinCount: spec.flecks,
            seed: Math.floor(spec.seed * 1000),
          }),
        );
      }

      if (spec.crystalClusters > 0) {
        const samples = sampleRockSurface(
          geo,
          spec.crystalClusters,
          Math.floor(spec.seed * 7919),
        );
        const stroke = crystalMode.createStroke(
          samples,
          Math.floor(spec.seed * 9973),
          {
            ...scenerySettings,
            crystalSize: scenerySettings.crystalSize * (0.7 + spec.scale * 0.5),
          },
        );
        stroke.finishGrowth();
        mesh.add(stroke.group);
        this.sceneryStrokes.push(stroke);
      }

      this.floatRoot.add(mesh);
    }
  }

  /** Post: MSAA scene pass + bloom + a gentle lens vignette, tone-mapped on output. */
  private setupPost(): void {
    const scenePass = pass(this.scene, this.camera, { samples: 4 });
    const color = scenePass.getTextureNode();
    this.bloomNode = bloom(
      color,
      this.settings.bloomStrength,
      0.6,
      this.settings.bloomThreshold,
    );
    const vignette = float(1).sub(
      smoothstep(0.55, 0.98, screenUV.distance(vec2(0.5, 0.5))).mul(0.18),
    );
    // Keep scene alpha so empty pixels stay transparent through bloom/vignette.
    const lit = color.add(this.bloomNode);
    this.post = new THREE.PostProcessing(this.renderer);
    this.post.outputNode = vec4(lit.rgb.mul(vignette), color.a);
  }

  // ---------- strokes ----------

  addStroke(samples: SurfaceSample[]): void {
    const stroke: Stroke = {
      samples,
      index: this.strokeCounter++,
      mode: this.settings.mode,
    };
    this.strokes.push(stroke);
    this.buildStroke(stroke, true);
  }

  private buildStroke(stroke: Stroke, animate: boolean): void {
    const seed = this.effectiveSeed(stroke.index);
    const instance = this.modes[stroke.mode].createStroke(
      stroke.samples,
      seed,
      this.settingsFor(stroke.mode),
    );
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
   * Push a mode's current settings into its live strokes IN PLACE — matrices, colors and
   * shader uniforms update on the existing objects, nothing is recreated. Falls back to a
   * rebuild only for stroke types that can't re-derive themselves.
   */
  updateModeSettings(mode: ModeName): void {
    let needRebuild = false;
    for (let i = 0; i < this.live.length; i++) {
      if (this.strokes[i].mode !== mode) continue;
      const s = this.live[i];
      if (s.applySettings) s.applySettings(this.settingsFor(mode));
      else needRebuild = true;
    }
    // Keep the random fill in sync with crystal look, but density stays max so
    // surfaceCoverage remains the only fill-amount control for those strokes.
    if (mode === "Crystals") {
      const coverageSettings = { ...this.crystal, clusterDensity: 16 };
      for (const s of this.coverageStrokes) {
        s.applySettings?.(coverageSettings);
      }
    }
    if (needRebuild) this.scheduleRegrow("instant");
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

  setBloomStrength(v: number): void {
    this.settings.bloomStrength = v;
    this.bloomNode.strength.value = v;
  }

  setBloomThreshold(v: number): void {
    this.settings.bloomThreshold = v;
    this.bloomNode.threshold.value = v;
  }

  // ---------- modes / hud ----------

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

    const btn = document.getElementById("modeBtn")!;
    btn.querySelector(".label")!.textContent = draw
      ? "Paint mode"
      : "Orbit mode";

    if (!draw) this.hovering = false;
    this.updateHud();
  }

  private updateHud(): void {
    const backend = (this.renderer.backend as { isWebGPUBackend?: boolean })
      .isWebGPUBackend
      ? "WebGPU"
      : "WebGL2 (fallback)";
    const nouns: Record<ModeName, string> = {
      Crystals: "crystal vein",
      "Molten fissures": "molten fissure",
      "Aurora silk": "silk of aurora",
      "Bioluminescent reef": "reef colony",
    };
    const noun = nouns[this.settings.mode];
    let mode: string;
    if (this.settings.drawMode) {
      mode = this.hovering
        ? `<b>Drag now</b> to paint a ${noun} across the rock — it grows when you let go.`
        : `Move over the rock, then <b>drag</b> to paint a ${noun}. Press <b>D</b> to orbit.`;
    } else {
      mode =
        "<b>Orbit mode</b> — drag to rotate, scroll to zoom, right-drag to pan. " +
        `Press <b>D</b> to paint.`;
    }
    this.hud.innerHTML = `${mode}<div class="sub">Mode: ${this.settings.mode} · Renderer: ${backend}</div>`;
  }

  private showToast(msg: string): void {
    const el = document.getElementById("toast")!;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(
      () => el.classList.remove("show"),
      1800,
    );
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
    for (const s of this.sceneryStrokes) s.update(dt, tSec);
    for (const s of this.coverageStrokes) s.update(dt, tSec);

    // All rocks share floatRoot — ease toward the mouse tilt (no idle spin).
    this.floatRoot.rotation.x = THREE.MathUtils.damp(
      this.floatRoot.rotation.x,
      this.tiltTarget.x,
      5,
      dt,
    );
    this.floatRoot.rotation.y = THREE.MathUtils.damp(
      this.floatRoot.rotation.y,
      this.tiltTarget.y,
      5,
      dt,
    );

    this.post.render();
  }
}

/**
 * Pick a few outward-facing surface points on a rock mesh to seed scenery crystals.
 * Prefer upper hemisphere so clusters read against the sky instead of hiding under the rock.
 */
function sampleRockSurface(
  geo: THREE.BufferGeometry,
  count: number,
  seed: number,
): SurfaceSample[] {
  geo.computeVertexNormals();
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const nrm = geo.getAttribute("normal") as THREE.BufferAttribute;
  const rnd = mulberry32(seed);
  const candidates: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    if (nrm.getY(i) > 0.15) candidates.push(i);
  }
  const pool =
    candidates.length > 0 ? candidates : [...Array(pos.count).keys()];
  const samples: SurfaceSample[] = [];
  for (let c = 0; c < count; c++) {
    const i = pool[Math.floor(rnd() * pool.length)]!;
    const local = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
    const localNormal = new THREE.Vector3(
      nrm.getX(i),
      nrm.getY(i),
      nrm.getZ(i),
    ).normalize();
    samples.push({
      position: local.clone(),
      normal: localNormal.clone(),
      local,
      localNormal,
    });
  }
  return samples;
}

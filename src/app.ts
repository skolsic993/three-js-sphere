import * as THREE from "three/webgpu";
import { float, pass, screenUV, smoothstep, vec2 } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { indexForRaycasts } from "./bvh";
import { SurfacePainter } from "./surfacePainter";
import type { PaintMode, StrokeInstance, SurfaceSample } from "./modes/mode";
import {
  crystalMode,
  defaultCrystalSettings,
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
} from "./rockGeometry";
import { createGoldFlecks } from "./goldFlecks";
import { buildGui } from "./ui";

export type ModeName =
  | "Crystals"
  | "Molten fissures"
  | "Aurora silk"
  | "Bioluminescent reef";

const GROUND_Y = -1.55; // the floor the rock floats above

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

  /** The floating canvas: rock + everything painted on it bob and turn together. */
  private floatRoot = new THREE.Group();
  private rock!: THREE.Mesh;
  private paintRoot = new THREE.Group(); // strokes parent here (child of floatRoot)

  private strokes: Stroke[] = [];
  private live: StrokeInstance[] = [];
  private strokeCounter = 0;

  private dust!: THREE.Points;
  private dustVel: number[] = [];
  /** The backlight/kicker pair, scaled together by the Backlight slider. */
  private backLights: { light: THREE.DirectionalLight; base: number }[] = [];

  private hud = document.getElementById("hud")!;
  private lastTime = 0;
  private hovering = false;
  private toastTimer = 0;
  private regrowPending: { mode: "instant" | "animate" } | null = null;
  private lastRegrowAt = 0;
  private regrowCost = 0;

  constructor(private container: HTMLElement) {}

  async start(): Promise<void> {
    const renderer = new THREE.WebGPURenderer({ antialias: true });
    await renderer.init();
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = this.settings.exposure;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene.background = new THREE.Color(0x0a0b10);
    this.scene.fog = new THREE.Fog(0x0a0b10, 10, 22);
    this.camera.position.set(3.7, 1.15, 3.3);

    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 7;
    this.controls.target.set(0, -0.05, 0);
    // Keep the camera above the horizon so you can't tumble under the floor.
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;

    this.setupEnvironment();
    this.setupLights();
    await this.setupCanvasRock();
    this.setupDust();
    this.setupPost();

    this.painter = new SurfacePainter(
      renderer.domElement,
      this.camera,
      this.scene,
      () => [this.rock],
      this.floatRoot,
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

    window.addEventListener("resize", this.onResize);
    this.onResize();

    renderer.setAnimationLoop((t) => this.tick(t));
  }

  // ---------- environment: a dark studio captured into a PMREM env map ----------

  /**
   * The "perfect light set" starts here: crystals and the lacquered sphere are mostly
   * REFLECTION, so what matters most is what there is to reflect. We build a black studio
   * with a huge overhead softbox, a cool strip camera-left, a warm strip camera-right and a
   * violet wash behind — classic three-point product lighting — and prefilter it into the
   * environment map. Every glossy highlight in the scene is one of these shapes.
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

    panel(0xfff6ea, 9, 4.5, 3, [1.5, 8, 2]); // overhead softbox, biased toward camera
    panel(0xffffff, 22, 0.7, 4.5, [-2.5, 5, -6]); // hard top-back strip — facet glints
    panel(0x9db8ff, 5, 1.2, 7, [-7, 2, -2]); // cool strip, camera-left
    panel(0xffd9b0, 3.5, 1.6, 5, [6, 1.5, 3]); // warm strip, camera-right
    panel(0x8a5cff, 4, 6, 3.5, [0, 2.5, -8]); // violet wash behind the subject
    panel(0x2e3c58, 1.2, 9, 9, [0, -5, 0]); // dim floor bounce

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(env, 0.04).texture;
    this.scene.environmentIntensity = this.settings.envIntensity;
    pmrem.dispose();
    geo.dispose();
  }

  /**
   * A cinematic three-point rig, tuned like a product macro shot:
   *  - KEY: a focused warm spot from top-front-right with a soft penumbra — a pool of
   *    light on the subject instead of a flat wash over the whole set.
   *  - BACKLIGHT + KICKER: cool violet-blue from behind. These are what make the
   *    transmissive crystals GLOW from within (transmission responds to light arriving
   *    from behind the surface) — the signature of the reference look.
   *  - FILL: a whisper of hemisphere so shadows never crush to pure black.
   */
  private setupLights(): void {
    const hemi = new THREE.HemisphereLight(0x8ea0c8, 0x0c0a14, 0.15);

    const key = new THREE.SpotLight(0xfff2e2, 70, 0, Math.PI / 5, 0.55, 1.8);
    key.position.set(3.4, 5.6, 2.6);
    key.target.position.set(0, 0, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 20;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 5; // soft penumbra under the floating sphere

    const back = new THREE.DirectionalLight(0xa9b8ff, 2.4);
    back.position.set(-3, 3.2, -4.5);
    const kick = new THREE.DirectionalLight(0xcaa6ff, 1.2);
    kick.position.set(4.5, 1.2, -3);
    this.backLights = [
      { light: back, base: 2.4 },
      { light: kick, base: 1.2 },
    ];

    // Faint violet underglow: lifts the sphere's shadowed underside off the floor,
    // selling the "floating" read.
    const under = new THREE.PointLight(0x6a4bd6, 0.4, 6, 1.6);
    under.position.set(0, GROUND_Y + 0.25, 0);

    // The floor: near-black satin with a soft radial sheen, mostly there to catch the
    // sphere's soft shadow and the crystals' colored bounce.
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(14, 64),
      new THREE.MeshPhysicalMaterial({
        map: makeFloorTexture(),
        color: 0xffffff,
        roughness: 0.95,
        metalness: 0,
        // The grey wash on a dark floor is SPECULAR (the huge overhead softbox reflected
        // by a rough surface), not albedo — so dim both specular paths hard.
        specularIntensity: 0.15,
        envMapIntensity: 0.15,
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = GROUND_Y;
    ground.receiveShadow = true;

    // Backdrop: a huge inward-facing sphere with soft violet blooms over near-black,
    // like the defocused studio behind a macro lens. Unlit and unfogged.
    const backdrop = new THREE.Mesh(
      new THREE.SphereGeometry(30, 32, 16),
      new THREE.MeshBasicMaterial({
        map: makeBackdropTexture(),
        side: THREE.BackSide,
        fog: false,
      }),
    );

    this.scene.add(hemi, key, key.target, back, kick, under, ground, backdrop);
  }

  /** The canvas itself: a jagged dark rock with Poly Haven PBR maps — quiet stage for crystals.
   *  Displacement is baked into the mesh so paint raycasts match the visible surface. */
  private async setupCanvasRock(): Promise<void> {
    const textures = await loadRockTextures();
    const geo = createRockGeometry(textures.displacementMap);
    const mat = createRockMaterial(textures);

    this.rock = new THREE.Mesh(geo, mat);
    this.rock.castShadow = true;
    this.rock.receiveShadow = true;

    const flecks = createGoldFlecks(geo);
    this.floatRoot.add(this.rock, flecks, this.paintRoot);
    this.scene.add(this.floatRoot);
    indexForRaycasts(this.floatRoot);
  }

  /** A whisper of drifting dust — depth cue and atmosphere, kept deliberately subtle. */
  private setupDust(): void {
    const N = 320;
    const positions = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const r = 1.9 + Math.random() * 4.5;
      const a = Math.random() * Math.PI * 2;
      positions[i * 3] = Math.cos(a) * r;
      positions[i * 3 + 1] = GROUND_Y + 0.1 + Math.random() * 4.2;
      positions[i * 3 + 2] = Math.sin(a) * r;
      this.dustVel.push(0.02 + Math.random() * 0.05);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.dust = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: 0x9db4e8,
        size: 0.02,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      }),
    );
    this.dust.frustumCulled = false;
    this.scene.add(this.dust);
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
    // Vignette: full exposure in the middle, ~35% falloff into the corners — pulls the
    // eye to the subject the way a fast lens does.
    const vignette = float(1).sub(
      smoothstep(0.5, 0.92, screenUV.distance(vec2(0.5, 0.5))).mul(0.35),
    );
    this.post = new THREE.PostProcessing(this.renderer);
    this.post.outputNode = color.add(this.bloomNode).mul(vignette);
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
    const toasts: Record<ModeName, string> = {
      Crystals: "💎 crystals seeded — watch them grow",
      "Molten fissures": "🔥 fissure torn open — stand back",
      "Aurora silk": "🌌 aurora silk unfurling — look up",
      "Bioluminescent reef": "🪸 reef colony seeded — watch it come alive",
    };
    this.showToast(toasts[stroke.mode]);
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
    if (needRebuild) this.scheduleRegrow("instant");
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

    // Dust drifts upward and wraps.
    const posAttr = this.dust.geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    const arr = posAttr.array as Float32Array;
    for (let i = 0; i < this.dustVel.length; i++) {
      arr[i * 3 + 1] += this.dustVel[i] * dt;
      if (arr[i * 3 + 1] > GROUND_Y + 4.4) arr[i * 3 + 1] = GROUND_Y + 0.1;
    }
    posAttr.needsUpdate = true;

    this.controls.update();
    this.painter.update(dt);
    for (const s of this.live) s.update(dt, tSec);

    this.post.render();
  }
}

/**
 * The out-of-focus studio behind the subject: near-black with two soft violet/blue blooms,
 * like distant practicals through a wide-open lens. Painted once onto a canvas and wrapped
 * on an inward-facing sphere.
 */
function makeBackdropTexture(): THREE.CanvasTexture {
  const w = 1024;
  const h = 512;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#06070b";
  ctx.fillRect(0, 0, w, h);

  const blob = (x: number, y: number, r: number, rgba: string): void => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };
  blob(w * 0.3, h * 0.38, 280, "rgba(74, 52, 138, 0.34)"); // violet bloom, camera-left
  blob(w * 0.78, h * 0.45, 220, "rgba(40, 58, 118, 0.22)"); // cooler bloom, camera-right
  blob(w * 0.55, h * 0.2, 180, "rgba(120, 100, 190, 0.10)"); // faint high sparkle wash

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Near-black satin floor with a soft radial sheen — a quiet stage for the sphere's shadow. */
function makeFloorTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  g.addColorStop(0, "#0f1118");
  g.addColorStop(0.45, "#0b0c12");
  g.addColorStop(1, "#08090d");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

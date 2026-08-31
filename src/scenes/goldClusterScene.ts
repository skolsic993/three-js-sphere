import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mulberry32 } from "../modes/mode";
import {
  createGoldRockMaterial,
  prepareGoldRockMaps,
  type GoldRockMaps,
} from "../goldMaps";
import {
  createRockGeometry,
  createRockMaterial,
  loadRockTextures,
  type RockTextures,
} from "../rockGeometry";
import { setupEnvironment, setupLights } from "../sceneLighting";

interface GoldSatelliteSpec {
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

export interface GoldClusterSettings {
  exposure: number;
  envIntensity: number;
}

/**
 * Decorative cluster: one flat charcoal center rock and three fully gold satellites.
 * Orbit-only — no paint mode, no GUI.
 */
export class GoldClusterScene {
  readonly settings: GoldClusterSettings = {
    exposure: 1.1,
    envIntensity: 0.9,
  };

  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  private controls!: OrbitControls;
  private floatRoot = new THREE.Group();
  private floatingRocks: RockFloat[] = [];

  constructor(private container: HTMLElement) {}

  async start(): Promise<void> {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    const dprCap = matchMedia("(pointer: coarse)").matches ? 1 : 1.5;
    renderer.setPixelRatio(Math.min(devicePixelRatio, dprCap));
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = this.settings.exposure;
    this.container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene.background = null;
    this.scene.fog = null;
    this.camera.position.set(25, 1.7, 5.6);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1;
    this.controls.maxDistance = 9;
    this.controls.target.set(0, -0.1, 0);
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;

    setupEnvironment(renderer, this.scene, this.settings.envIntensity);
    setupLights(this.scene);

    const [rockTextures, goldMaps] = await Promise.all([
      loadRockTextures(renderer.capabilities.getMaxAnisotropy()),
      prepareGoldRockMaps(),
    ]);

    this.buildRocks(rockTextures, goldMaps);

    window.addEventListener("resize", this.onResize);
    this.onResize();

    renderer.setAnimationLoop((t) => this.tick(t));
  }

  private buildRocks(rockTextures: RockTextures, goldMaps: GoldRockMaps): void {
    // Same PBR maps + material as the paint-scene rock — no 3D flecks or crystals on top.
    const rockMaterial = createRockMaterial(rockTextures);
    const goldMaterial = createGoldRockMaterial(goldMaps, {
      normalMap: rockTextures.normalMap,
      envMapIntensity: 1.0,
    });

    const mainRock = new THREE.Group();
    const centerGeo = createRockGeometry(rockTextures.displacementMap, {
      profile: "tablet",
      scale: 1.5,
      seed: 4.1,
      detail: 7,
    });
    const center = new THREE.Mesh(centerGeo, rockMaterial);
    mainRock.add(center);
    mainRock.rotation.set(1.52, 0.26, 0.32);
    this.floatRoot.add(mainRock);
    this.registerRockFloat(mainRock, 0x7a1, { calm: true });

    const goldSpecs: GoldSatelliteSpec[] = [
      {
        seed: 11.3,
        scale: 0.32,
        detail: 5,
        position: [-1.15, 0.85, 0.45],
        rotation: [0.45, 1.2, -0.25],
      },
      {
        seed: 22.7,
        scale: 0.28,
        detail: 5,
        position: [-0.95, -0.75, 0.55],
        rotation: [-0.35, 0.55, 0.42],
      },
      {
        seed: 33.1,
        scale: 0.3,
        detail: 5,
        position: [1.25, 0.05, -0.35],
        rotation: [0.55, -0.65, 0.2],
      },
    ];

    for (const spec of goldSpecs) {
      const geo = createRockGeometry(rockTextures.displacementMap, {
        detail: spec.detail,
        scale: spec.scale,
        seed: spec.seed,
        profile: "teardrop",
      });
      const mesh = new THREE.Mesh(geo, goldMaterial);
      mesh.position.set(...spec.position);
      mesh.rotation.set(...spec.rotation);
      this.floatRoot.add(mesh);
      this.registerRockFloat(mesh, Math.floor(spec.seed * 1000));
    }

    this.scene.add(this.floatRoot);
  }

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

  private onResize = (): void => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  private tick(time: number): void {
    const tSec = time / 1000;

    this.controls.update();

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

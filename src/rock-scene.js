import * as THREE from "three";
import {OrbitControls} from "three/addons/controls/OrbitControls.js";
import {RoomEnvironment} from "three/addons/environments/RoomEnvironment.js";
import {createNoise3D} from "simplex-noise";
import {loadRockTextures, applyRockSurface} from "./rock-surface.js";

const CONFIG = {
  seed: 20260827,

  // --- shape ---
  detail: 24, // needs to be high: facet edges are approximated
  radius: 1,
  noiseScale: 1.3,
  amplitude: 0.16, // the cuts do the shaping, noise only adds irregularity
  octaves: 4,
  cuts: 11, // number of fracture planes
  cutMin: 0.52, // closest a plane can sit to the centre (deep slice)
  cutMax: 0.92, // furthest (shallow chip)
  squash: [1.15, 0.78, 0.95],
  tilt: [0.35, 0.6, -0.25],

  // --- look ---
  tint: 0x707070, // multiplies the diffuse texture. lower = darker rock
  metalness: 0.15,
  envMapIntensity: 0.45,
  exposure: 1.1,

  minZoomFactor: 0.35,
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeFbm(noise3D, octaves) {
  return (x, y, z) => {
    let value = 0;
    let amplitude = 0.5;
    let frequency = 1;
    for (let i = 0; i < octaves; i++) {
      value += amplitude * noise3D(x * frequency, y * frequency, z * frequency);
      amplitude *= 0.5;
      frequency *= 2;
    }
    return value;
  };
}

/* Uniformly distributed direction on the unit sphere.
   Naive random x/y/z normalised would clump toward the cube corners. */
function randomDirection(random) {
  const z = random() * 2 - 1;
  const angle = random() * Math.PI * 2;
  const s = Math.sqrt(1 - z * z);
  return new THREE.Vector3(s * Math.cos(angle), s * Math.sin(angle), z);
}

function buildRockGeometry(config) {
  const random = mulberry32(config.seed);
  const fbm = makeFbm(createNoise3D(random), config.octaves);

  const geometry = new THREE.IcosahedronGeometry(config.radius, config.detail);
  const position = geometry.attributes.position;
  const v = new THREE.Vector3();

  // PASS 1 - noise. Gives the silhouette organic irregularity so the cut
  // faces don't all meet at suspiciously tidy angles.
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    const n = fbm(
      v.x * config.noiseScale,
      v.y * config.noiseScale,
      v.z * config.noiseScale,
    );
    v.multiplyScalar(1 + n * config.amplitude);
    position.setXYZ(i, v.x, v.y, v.z);
  }

  // PASS 2 - fracture. Each plane is a half-space; any vertex outside it gets
  // projected straight down onto it. Everything that lands on a given plane is
  // now exactly coplanar, which is what produces the hard facet edges.
  const planes = [];
  for (let i = 0; i < config.cuts; i++) {
    planes.push({
      normal: randomDirection(random),
      distance: THREE.MathUtils.lerp(config.cutMin, config.cutMax, random()),
    });
  }

  // Two passes: projecting onto plane A can push a vertex outside plane B.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i);
      for (const plane of planes) {
        const d = v.dot(plane.normal) - plane.distance;
        if (d > 0) v.addScaledVector(plane.normal, -d);
      }
      position.setXYZ(i, v.x, v.y, v.z);
    }
  }

  geometry.scale(...config.squash);

  position.needsUpdate = true;
  // Non-indexed geometry, so this gives every vertex its own face normal -
  // the normal attribute ends up faceted without needing flatShading.
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  return geometry;
}

export function createRockScene(container, options = {}) {
  if (!container) throw new Error("createRockScene: container not found");
  const config = {...CONFIG, ...options};

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05060a);

  const camera = new THREE.PerspectiveCamera(
    40,
    container.clientWidth / container.clientHeight,
    0.1,
    100,
  );

  const renderer = new THREE.WebGLRenderer({antialias: true});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = config.exposure;
  container.appendChild(renderer.domElement);

  /* Environment map. Without this, every surface not hit by a light is dead
     flat - a big part of why the untextured version read as plastic. Bakes a
     small procedural room into a cubemap the material can reflect. */
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envMap;
  pmrem.dispose();

  // Needs the renderer: texture setup reads renderer.capabilities.
  const textures = loadRockTextures(renderer);

  const geometry = buildRockGeometry(config);
  const material = new THREE.MeshStandardMaterial({
    metalness: config.metalness,
    envMapIntensity: config.envMapIntensity,
  });
  // Sets color/roughness/flatShading itself, so those are deliberately absent
  // from the constructor above.
  applyRockSurface(material, textures);
  // Applied after, so it multiplies against the diffuse texture and darkens
  // the rock without flattening any of its detail.
  material.color.set(config.tint);

  const rock = new THREE.Mesh(geometry, material);
  rock.rotation.set(...config.tilt);
  scene.add(rock);

  /* Lighting: one dominant source, everything else subordinate. Near-equal
     lights on a dark object average out to muddy brown. */
  const key = new THREE.DirectionalLight(0xfff2dd, 4.5);
  key.position.set(5, 6, 4);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0xffb43a, 1.6);
  rim.position.set(-5, 0.5, -4);
  scene.add(rim);

  const fill = new THREE.DirectionalLight(0x4a6a99, 0.5);
  fill.position.set(-3, -4, 2);
  scene.add(fill);

  /* Derive camera distances from the rock's actual size, so retuning the
     noise or the cuts can't break the framing. */
  const r = geometry.boundingSphere.radius;
  const fovRad = THREE.MathUtils.degToRad(camera.fov);
  const fitDistance = (r / Math.sin(fovRad / 2)) * 1.15;

  camera.position.set(0, 0.3, fitDistance);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.maxDistance = fitDistance;
  controls.minDistance = fitDistance * config.minZoomFactor;
  controls.rotateSpeed = 0.6;
  controls.zoomSpeed = 0.5;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.35;

  /* ResizeObserver, not window.resize - the container can change size without
     the window doing anything (sidebars, layout shifts). */
  const resizeObserver = new ResizeObserver(() => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
  resizeObserver.observe(container);

  renderer.setAnimationLoop(() => {
    controls.update(); // required: damping and autoRotate are on
    renderer.render(scene, camera);
  });

  return {
    scene,
    camera,
    rock,
    material,
    dispose() {
      renderer.setAnimationLoop(null);
      resizeObserver.disconnect();
      controls.dispose();
      geometry.dispose();
      material.dispose();
      envMap.dispose();
      // Optional slot `ao` is null, hence the optional chaining.
      Object.values(textures).forEach((t) => t?.dispose());
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

import * as THREE from "three";

/**
 * Procedural rock canvas: an irregular ore-like chunk (asymmetric taper + warped noise),
 * with Poly Haven dark_rock displacement baked into vertices so BVH painting hits what
 * you see. Intentionally not spherical.
 */

export interface RockTextures {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  displacementMap: THREE.Texture;
}

const TEX_BASE = "/textures";

export async function loadRockTextures(): Promise<RockTextures> {
  const loader = new THREE.TextureLoader();
  const [map, normalMap, roughnessMap, displacementMap] = await Promise.all([
    loader.loadAsync(`${TEX_BASE}/dark_rock_diff_2k.jpg`),
    loader.loadAsync(`${TEX_BASE}/dark_rock_nor_gl_2k.jpg`),
    loader.loadAsync(`${TEX_BASE}/dark_rock_rough_2k.jpg`),
    loader.loadAsync(`${TEX_BASE}/dark_rock_disp_2k.jpg`),
  ]);

  map.colorSpace = THREE.SRGBColorSpace;
  for (const tex of [normalMap, roughnessMap, displacementMap]) {
    tex.colorSpace = THREE.NoColorSpace;
  }
  for (const tex of [map, normalMap, roughnessMap, displacementMap]) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
  }

  return { map, normalMap, roughnessMap, displacementMap };
}

/** Hash → [0, 1) for stable per-vertex procedural noise. */
function hash3(x: number, y: number, z: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

/** Value noise in [-1, 1] with trilinear-ish blending of hashed corners. */
function valueNoise(x: number, y: number, z: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fy = y - y0;
  const fz = z - z0;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);

  const n = (ix: number, iy: number, iz: number) => hash3(ix, iy, iz) * 2 - 1;
  const x00 = n(x0, y0, z0) * (1 - ux) + n(x0 + 1, y0, z0) * ux;
  const x10 = n(x0, y0 + 1, z0) * (1 - ux) + n(x0 + 1, y0 + 1, z0) * ux;
  const x01 = n(x0, y0, z0 + 1) * (1 - ux) + n(x0 + 1, y0, z0 + 1) * ux;
  const x11 = n(x0, y0 + 1, z0 + 1) * (1 - ux) + n(x0 + 1, y0 + 1, z0 + 1) * ux;
  const y0z = x00 * (1 - uy) + x10 * uy;
  const y1z = x01 * (1 - uy) + x11 * uy;
  return y0z * (1 - uz) + y1z * uz;
}

function fbm(x: number, y: number, z: number, octaves: number): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq, y * freq, z * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.05;
  }
  return sum / norm;
}

function sampleDisplacement(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  u: number,
  v: number,
): number {
  // Repeat wrap to match texture wrap mode.
  const uu = ((u % 1) + 1) % 1;
  const vv = ((v % 1) + 1) % 1;
  const x = Math.min(width - 1, Math.floor(uu * width));
  const y = Math.min(height - 1, Math.floor((1 - vv) * height));
  const i = (y * width + x) * 4;
  return data[i]! / 255;
}

/**
 * Build a ~unit-radius rock that reads as an irregular ore chunk — not a bumpy sphere.
 * Large anisotropic warp + layered noise set the silhouette; the displacement map adds
 * craggy surface detail (baked so BVH painting matches what you see).
 */
export function createRockGeometry(
  displacementMap: THREE.Texture,
  opts: {
    detail?: number;
    dispStrength?: number;
    warpStrength?: number;
    seed?: number;
  } = {},
): THREE.BufferGeometry {
  const detail = opts.detail ?? 5;
  const dispStrength = opts.dispStrength ?? 0.18;
  const warpStrength = opts.warpStrength ?? 0.55;
  const seed = opts.seed ?? 2.4;

  const geo = new THREE.IcosahedronGeometry(1, detail);
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const uv = geo.getAttribute("uv") as THREE.BufferAttribute;

  const img = displacementMap.image as HTMLImageElement | ImageBitmap;
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not sample rock displacement map");
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(
    0,
    0,
    canvas.width,
    canvas.height,
  );

  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);

    // --- 1. Break the sphere: asymmetric stretch (wide + tall, thin depth) ---
    p.x *= 1.35;
    p.y *= 1.2;
    p.z *= 0.72;

    // Soft lean so it doesn't sit axis-aligned like a primitive.
    const lean = 0.18;
    const x0 = p.x + p.y * lean;
    const y0 = p.y - p.x * lean * 0.35;
    p.x = x0;
    p.y = y0;

    // --- 2. Taper like ore: wider shoulders, pointed tip toward -Y ---
    const yN = THREE.MathUtils.clamp(p.y / 1.35, -1, 1);
    // Bottom tip shrinks; top stays broad / slightly flared.
    const taper = 0.55 + 0.55 * (yN * 0.5 + 0.5);
    const shoulder = 1 + 0.22 * Math.max(0, yN);
    p.x *= taper * shoulder;
    p.z *= taper * (0.9 + 0.1 * shoulder);

    // --- 3. Domain-warped fBm: chunky lobes and deep bites in the outline ---
    const sx = p.x * 1.1 + seed;
    const sy = p.y * 1.1 + seed * 1.7;
    const sz = p.z * 1.1 + seed * 0.6;
    const warpX = fbm(sx + 17, sy, sz, 3);
    const warpY = fbm(sx, sy + 31, sz, 3);
    const warpZ = fbm(sx, sy, sz + 47, 3);
    const n1 = fbm(sx + warpX * 0.8, sy + warpY * 0.8, sz + warpZ * 0.8, 4);
    const n2 = fbm(sx * 2.3 + 9, sy * 2.3, sz * 2.3, 3);
    // Quantized facet layer — sharp planar cuts instead of soft blobs.
    const qx = Math.round(p.x * 2.2 + seed);
    const qy = Math.round(p.y * 2.2 + seed * 1.3);
    const qz = Math.round(p.z * 2.2 + seed * 0.7);
    const facet = hash3(qx, qy, qz) * 2 - 1;

    const radial = 1 + warpStrength * (0.55 * n1 + 0.28 * n2 + 0.32 * facet);

    p.multiplyScalar(Math.max(0.35, radial));

    // Push a couple of lobes off-center so left/right don't mirror.
    p.x += fbm(sy * 0.8, sz * 0.8, seed + 3, 2) * warpStrength * 0.28;
    p.z += fbm(sx * 0.8, sy * 0.8, seed + 5, 2) * warpStrength * 0.22;

    // --- 4. Bake height map for craggy micro-detail (along outward direction) ---
    const h = sampleDisplacement(data, width, height, uv.getX(i), uv.getY(i));
    const len = p.length() || 1;
    const disp = (h - 0.5) * 2 * dispStrength;
    p.addScaledVector(p, disp / len);

    pos.setXYZ(i, p.x, p.y, p.z);
  }

  pos.needsUpdate = true;

  // Center the chunk so it floats on the same stage as the old sphere.
  geo.computeBoundingBox();
  const box = geo.boundingBox!;
  const center = new THREE.Vector3();
  box.getCenter(center);
  geo.translate(-center.x, -center.y, -center.z);

  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  // Keep overall scale near unit radius so framing / paint feel unchanged.
  const radius = geo.boundingSphere?.radius ?? 1;
  if (radius > 0) {
    geo.scale(1 / radius, 1 / radius, 1 / radius);
    geo.computeBoundingSphere();
  }

  return geo;
}

export function createRockMaterial(
  textures: RockTextures,
): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    map: textures.map,
    normalMap: textures.normalMap,
    normalScale: new THREE.Vector2(1.1, 1.1),
    roughnessMap: textures.roughnessMap,
    roughness: 1,
    metalness: 0.04,
    clearcoat: 0.12,
    clearcoatRoughness: 0.55,
    envMapIntensity: 0.4,
  });
}

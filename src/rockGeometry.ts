import * as THREE from "three";
import { compositeRockAlbedoWithGold, loadGoldStrip } from "./goldMaps";

/**
 * Procedural charcoal ore chunk — organic, crumbly, matte.
 * Driven by domain-warped ridged noise + baked displacement (not gem facets).
 */

export interface RockTextures {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  metalnessMap: THREE.Texture;
  displacementMap: THREE.Texture;
}

const TEX_BASE = "/textures";
/** Keep in sync with UV sampling in createRockGeometry. */
const TEX_REPEAT = 1.05;

export async function loadRockTextures(): Promise<RockTextures> {
  const loader = new THREE.TextureLoader();
  const [rawMap, normalMap, displacementMap, goldStrip] = await Promise.all([
    loader.loadAsync(`${TEX_BASE}/dark_rock_diff_2k.png`),
    loader.loadAsync(`${TEX_BASE}/dark_rock_nor_gl_2k.jpg`),
    loader.loadAsync(`${TEX_BASE}/dark_rock_disp_2k.jpg`),
    loadGoldStrip(),
  ]);

  const { map, metalnessMap, roughnessMap } = compositeRockAlbedoWithGold(
    rawMap,
    goldStrip,
  );

  for (const tex of [normalMap, displacementMap]) {
    tex.colorSpace = THREE.NoColorSpace;
  }
  for (const tex of [
    map,
    normalMap,
    roughnessMap,
    metalnessMap,
    displacementMap,
  ]) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 16;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.repeat.set(TEX_REPEAT, TEX_REPEAT);
  }

  return { map, normalMap, roughnessMap, metalnessMap, displacementMap };
}

/** Hash → [0, 1) for stable per-vertex procedural noise. */
function hash3(x: number, y: number, z: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

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

/** Ridged multifractal — sharp natural ridges and crumbly valleys. */
function ridged(x: number, y: number, z: number, octaves: number): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  let weight = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(valueNoise(x * freq, y * freq, z * freq));
    n *= n;
    n *= weight;
    sum += n * amp;
    norm += amp;
    weight = Math.min(1, n * 2);
    amp *= 0.5;
    freq *= 2.1;
  }
  return sum / norm;
}

/**
 * Soft Worley valleys only — crevices between lobes, never flat facet planes.
 */
function creviceMask(
  px: number,
  py: number,
  pz: number,
  scale: number,
  seed: number,
): number {
  const gx = Math.floor(px * scale);
  const gy = Math.floor(py * scale);
  const gz = Math.floor(pz * scale);
  let d1 = Infinity;
  let d2 = Infinity;

  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      for (let oz = -1; oz <= 1; oz++) {
        const ix = gx + ox;
        const iy = gy + oy;
        const iz = gz + oz;
        const jx = hash3(ix + seed, iy, iz);
        const jy = hash3(ix, iy + seed * 1.7, iz);
        const jz = hash3(ix, iy, iz + seed * 2.3);
        const dx = px - (ix + jx) / scale;
        const dy = py - (iy + jy) / scale;
        const dz = pz - (iz + jz) / scale;
        const d = Math.hypot(dx, dy, dz);
        if (d < d1) {
          d2 = d1;
          d1 = d;
        } else if (d < d2) {
          d2 = d;
        }
      }
    }
  }

  const edge = Math.max(0, d2 - d1);
  const seam = Math.max(0, 1 - edge * scale * 2.8);
  return seam * seam;
}

function sampleDisplacement(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  u: number,
  v: number,
): number {
  const uu = ((u % 1) + 1) % 1;
  const vv = ((v % 1) + 1) % 1;
  const x = Math.min(width - 1, Math.floor(uu * width));
  const y = Math.min(height - 1, Math.floor((1 - vv) * height));
  const i = (y * width + x) * 4;
  return data[i]! / 255;
}

/**
 * Large organic ore chunk: irregular silhouette, crumbly ridges, deep natural crevices.
 * Indexed mesh with smooth normals so PBR maps read as matte charcoal stone — not a gem cut.
 */
export function createRockGeometry(
  displacementMap: THREE.Texture,
  opts: {
    detail?: number;
    scale?: number;
    seed?: number;
  } = {},
): THREE.BufferGeometry {
  const detail = opts.detail ?? 7;
  const scale = opts.scale ?? 2.55;
  const seed = opts.seed ?? 4.1;

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

  // A few soft fracture bites — distance is noise-modulated so edges stay jagged, not planar.
  const cuts: { nx: number; ny: number; nz: number; d: number }[] = [];
  for (let c = 0; c < 6; c++) {
    const nx = hash3(c + seed, 1.1, 2.2) * 2 - 1;
    const ny = hash3(c + seed, 3.3, 4.4) * 2 - 1;
    const nz = hash3(c + seed, 5.5, 6.6) * 2 - 1;
    const len = Math.hypot(nx, ny, nz) || 1;
    cuts.push({
      nx: nx / len,
      ny: ny / len,
      nz: nz / len,
      d: 0.62 + hash3(c + seed, 7.7, 8.8) * 0.45,
    });
  }

  const p = new THREE.Vector3();
  const dir = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);

    // --- 1. Chunky asymmetric proportions (compact ore lump, not a spike cluster) ---
    p.x *= 1.22;
    p.y *= 1.05;
    p.z *= 0.92;
    const lean = 0.18;
    const x1 = p.x + p.y * lean;
    const y1 = p.y - p.x * 0.08;
    const z1 = p.z + p.x * 0.05;
    // Mild one-sided mass so it feels like a broken specimen, not a sphere.
    const mass =
      1 +
      0.12 * Math.max(0, x1 * 0.4 + y1 * 0.5) +
      0.14 * fbm(x1 * 0.55 + seed, y1 * 0.55, z1 * 0.55, 3);
    p.set(x1 * mass, y1 * mass, z1 * (0.95 + 0.08 * mass));

    dir.copy(p);
    const plen = dir.length() || 1;
    dir.multiplyScalar(1 / plen);

    // --- 2. Domain warp → organic folds instead of geometric cells ---
    const wx = fbm(p.x * 0.9 + seed, p.y * 0.9, p.z * 0.9, 4) * 0.55;
    const wy = fbm(p.x * 0.9 + 17, p.y * 0.9 + seed, p.z * 0.9, 4) * 0.55;
    const wz = fbm(p.x * 0.9, p.y * 0.9 + 29, p.z * 0.9 + seed, 4) * 0.55;
    const qx = p.x + wx;
    const qy = p.y + wy;
    const qz = p.z + wz;

    // Ridged macro shape: crumbly ridges + valleys (the reference silhouette).
    const ridges = ridged(qx * 1.15 + seed, qy * 1.15, qz * 1.15, 5);
    const broad = fbm(qx * 0.7 + seed * 2, qy * 0.7, qz * 0.7, 4);
    const fine = fbm(qx * 2.8, qy * 2.8 + seed, qz * 2.8, 3);
    const crevice = creviceMask(qx, qy, qz, 1.1, seed);

    let r = 0.78 + ridges * 0.38 + broad * 0.16 + fine * 0.06 - crevice * 0.18;

    // Keep a solid core so thin spikes don't form.
    r = Math.max(0.55, r);

    p.copy(dir).multiplyScalar(r);

    // --- 3. Soft fracture bites with jagged (noise-broken) lips ---
    for (const cut of cuts) {
      const side = p.x * cut.nx + p.y * cut.ny + p.z * cut.nz;
      const jagged =
        cut.d +
        fbm(p.x * 3.2 + seed, p.y * 3.2, p.z * 3.2, 3) * 0.12 +
        ridged(p.x * 2.4, p.y * 2.4 + seed, p.z * 2.4, 2) * 0.08;
      if (side > jagged) {
        const excess = side - jagged;
        // Feathered push — avoids clean planar faces.
        const t = Math.min(1, excess / 0.4);
        const soft = t * t * (3 - 2 * t);
        p.x -= cut.nx * excess * soft;
        p.y -= cut.ny * excess * soft;
        p.z -= cut.nz * excess * soft;
      }
    }

    // Bake Poly Haven displacement as real surface relief (UVs match texture.repeat).
    const u = uv.getX(i) * TEX_REPEAT;
    const v = uv.getY(i) * TEX_REPEAT;
    const h = sampleDisplacement(data, width, height, u, v);
    const outward = p.length() || 1;
    const relief =
      (h - 0.5) * 0.28 +
      ridged(p.x * 4.5 + seed, p.y * 4.5, p.z * 4.5, 3) * 0.07 -
      crevice * 0.04;
    p.addScaledVector(p, relief / outward);

    pos.setXYZ(i, p.x, p.y, p.z);
  }

  pos.needsUpdate = true;

  geo.computeBoundingBox();
  const box = geo.boundingBox!;
  const center = new THREE.Vector3();
  box.getCenter(center);
  geo.translate(-center.x, -center.y, -center.z);

  // Smooth normals — texture/normal maps carry the stone grain, not flat-shaded polys.
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const radius = geo.boundingSphere?.radius ?? 1;
  if (radius > 0) {
    const s = scale / radius;
    geo.scale(s, s, s);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
  }

  return geo;
}

export function createRockMaterial(
  textures: RockTextures,
): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: textures.map,
    normalMap: textures.normalMap,
    normalScale: new THREE.Vector2(1.35, 1.35),
    roughnessMap: textures.roughnessMap,
    roughness: 1,
    metalnessMap: textures.metalnessMap,
    metalness: 1, // scratched-gold flecks from metalnessMap catch studio lights
    clearcoat: 0,
    envMapIntensity: 0.85,
    specularIntensity: 0.45,
  });
}

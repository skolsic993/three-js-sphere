import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { compositeRockAlbedoWithGold, loadGoldStrip } from "./goldMaps";

/**
 * Procedural charcoal ore chunk — tall fractured teardrop with sharp cleavage
 * edges and a deep front gouge. Ridged noise + baked displacement for crust;
 * authored cuts and a cavity for the silhouette (not a gem cut).
 */

export interface RockTextures {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  metalnessMap: THREE.Texture;
  displacementMap: THREE.Texture;
  aoMap: THREE.Texture;
}

const TEX_BASE = "/textures";
/** Keep in sync with UV sampling in createRockGeometry. */
const TEX_REPEAT = 3;
/** Cap GPU map resolution (normal + composited albedo) to cut VRAM / bandwidth. */
const GPU_TEX_MAX = 2048;

/**
 * Downsample a loaded texture's image onto a canvas when either edge exceeds `maxSize`.
 * Disposes the source texture when a new one is created.
 */
function downsampleTexture(
  tex: THREE.Texture,
  maxSize: number,
): THREE.Texture {
  const img = tex.image as HTMLImageElement | ImageBitmap | undefined;
  if (!img || !("width" in img)) return tex;
  const w = img.width;
  const h = img.height;
  if (w <= maxSize && h <= maxSize) return tex;

  const scale = maxSize / Math.max(w, h);
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = nw;
  canvas.height = nh;
  const ctx = canvas.getContext("2d");
  if (!ctx) return tex;
  ctx.drawImage(img, 0, 0, nw, nh);

  const out = new THREE.CanvasTexture(canvas);
  out.colorSpace = tex.colorSpace;
  out.wrapS = tex.wrapS;
  out.wrapT = tex.wrapT;
  out.magFilter = tex.magFilter;
  out.minFilter = tex.minFilter;
  out.generateMipmaps = tex.generateMipmaps;
  out.anisotropy = tex.anisotropy;
  out.repeat.copy(tex.repeat);
  out.needsUpdate = true;
  tex.dispose();
  return out;
}

/** Hermite smoothstep for soft AO falloff from valleys to peaks. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Derive ambient occlusion from Poly Haven displacement: recesses darken,
 * peaks stay open. Gold flecks (high metalness) stay fully unoccluded.
 */
function buildRockAoMap(
  displacementMap: THREE.Texture,
  metalnessMap: THREE.Texture,
): THREE.CanvasTexture {
  const dispImg = displacementMap.image as HTMLImageElement | ImageBitmap;
  const metalImg = metalnessMap.image as
    | HTMLImageElement
    | ImageBitmap
    | HTMLCanvasElement;
  const w = dispImg.width;
  const h = dispImg.height;

  const dispCanvas = document.createElement("canvas");
  dispCanvas.width = w;
  dispCanvas.height = h;
  const dCtx = dispCanvas.getContext("2d", { willReadFrequently: true });
  if (!dCtx) throw new Error("Could not sample rock displacement for AO");
  dCtx.drawImage(dispImg, 0, 0);
  const disp = dCtx.getImageData(0, 0, w, h).data;

  const metalCanvas = document.createElement("canvas");
  metalCanvas.width = w;
  metalCanvas.height = h;
  const mCtx = metalCanvas.getContext("2d", { willReadFrequently: true });
  if (!mCtx) throw new Error("Could not sample metalness for AO");
  mCtx.drawImage(metalImg, 0, 0, w, h);
  const metal = mCtx.getImageData(0, 0, w, h).data;

  const aoCanvas = document.createElement("canvas");
  aoCanvas.width = w;
  aoCanvas.height = h;
  const aCtx = aoCanvas.getContext("2d");
  if (!aCtx) throw new Error("Could not build rock AO map");
  const aoImage = aCtx.createImageData(w, h);
  const ao = aoImage.data;

  const darkFloor = 0.28;
  const low = 0.25;
  const high = 0.72;

  for (let i = 0; i < w * h; i++) {
    const px = i * 4;
    if (metal[px]! >= 128) {
      ao[px] = ao[px + 1] = ao[px + 2] = 255;
    } else {
      const height = disp[px]! / 255;
      const open = smoothstep(low, high, height);
      const val = Math.round((darkFloor + (1 - darkFloor) * open) * 255);
      ao[px] = ao[px + 1] = ao[px + 2] = val;
    }
    ao[px + 3] = 255;
  }

  aCtx.putImageData(aoImage, 0, 0);
  const tex = new THREE.CanvasTexture(aoCanvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export async function loadRockTextures(
  maxAnisotropy = 16,
): Promise<RockTextures> {
  const loader = new THREE.TextureLoader();
  const [rawMap, rawNormal, displacementMap, roughnessSrc, goldStrip] =
    await Promise.all([
      loader.loadAsync(`${TEX_BASE}/dark_rock.webp`),
      loader.loadAsync(`${TEX_BASE}/dark_rock_nor.webp`),
      loader.loadAsync(`${TEX_BASE}/dark_rock_disp.webp`),
      loader.loadAsync(`${TEX_BASE}/dark_rock_rough.webp`),
      loadGoldStrip(),
    ]);

  // Normal is the largest GPU-only map (~11MB source); cap before upload.
  const normalMap = downsampleTexture(rawNormal, GPU_TEX_MAX);

  const { map, metalnessMap, roughnessMap } = compositeRockAlbedoWithGold(
    rawMap,
    goldStrip,
    roughnessSrc,
  );
  const aoMap = buildRockAoMap(displacementMap, metalnessMap);

  for (const tex of [normalMap, displacementMap, aoMap]) {
    tex.colorSpace = THREE.NoColorSpace;
  }
  for (const tex of [
    map,
    normalMap,
    roughnessMap,
    metalnessMap,
    displacementMap,
    aoMap,
  ]) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = maxAnisotropy;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.repeat.set(TEX_REPEAT, TEX_REPEAT);
  }

  return {
    map,
    normalMap,
    roughnessMap,
    metalnessMap,
    displacementMap,
    aoMap,
  };
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
 * Spherical UVs matching PolyhedronGeometry's azimuth/inclination mapping.
 * Applied on the welded unit sphere before deform (displacement bake needs them).
 */
function applySphericalUVs(geo: THREE.BufferGeometry): void {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const uvs = new Float32Array(pos.count * 2);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const u = Math.atan2(v.z, -v.x) / (Math.PI * 2) + 0.5;
    const incl = Math.atan2(-v.y, Math.sqrt(v.x * v.x + v.z * v.z));
    uvs[i * 2] = u;
    uvs[i * 2 + 1] = 1 - (incl / Math.PI + 0.5);
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
}

/**
 * PolyhedronGeometry.correctSeam — faces that straddle u=0/1 get U pushed into a
 * continuous range so RepeatWrapping doesn't smear across the whole map.
 * Requires non-indexed geometry (per-corner UVs).
 */
function correctUvSeams(geo: THREE.BufferGeometry): void {
  const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i += 3) {
    const x0 = uv.getX(i);
    const x1 = uv.getX(i + 1);
    const x2 = uv.getX(i + 2);
    const max = Math.max(x0, x1, x2);
    const min = Math.min(x0, x1, x2);
    if (max > 0.9 && min < 0.1) {
      if (x0 < 0.2) uv.setX(i, x0 + 1);
      if (x1 < 0.2) uv.setX(i + 1, x1 + 1);
      if (x2 < 0.2) uv.setX(i + 2, x2 + 1);
    }
  }
  uv.needsUpdate = true;
}

interface FractureCut {
  nx: number;
  ny: number;
  nz: number;
  d: number;
}

function pushCut(
  cuts: FractureCut[],
  nx: number,
  ny: number,
  nz: number,
  d: number,
): void {
  const len = Math.hypot(nx, ny, nz) || 1;
  cuts.push({ nx: nx / len, ny: ny / len, nz: nz / len, d });
}

/**
 * Tall fractured teardrop: bulky top, tapered tip, deep front gouge, hard cleavage.
 * Smooth normals so PBR maps still read as matte charcoal — not a gem cut.
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

  // PolyhedronGeometry is non-indexed (duplicate verts for UV seams). Weld by
  // position only — mergeVertices hashes *all* attributes, so differing seam UVs
  // would leave duplicates and the displacement bake would tear holes again.
  const raw = new THREE.IcosahedronGeometry(1, detail);
  raw.deleteAttribute("uv");
  raw.deleteAttribute("normal");
  const geo = mergeVertices(raw, 1e-4);
  raw.dispose();
  applySphericalUVs(geo);
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

  // Authored cleavage first so the silhouette isn't seed-luck; hashed extras for variety.
  const cuts: FractureCut[] = [];
  // Left flank — near-parallel vertical shears (stepped ridges).
  pushCut(cuts, -1.0, 0.06, 0.16, 0.5);
  pushCut(cuts, -0.96, 0.14, -0.1, 0.57);
  pushCut(cuts, -0.9, -0.04, 0.32, 0.63);
  // Front-lower face beside the gouge.
  pushCut(cuts, 0.78, -0.38, 0.18, 0.46);
  // Bottom tip shears — off-center ragged point (d low enough to actually bite the taper).
  pushCut(cuts, 0.18, -1.0, 0.28, 0.42);
  pushCut(cuts, -0.38, -0.88, -0.18, 0.48);
  // Upper blunt peaks.
  pushCut(cuts, 0.22, 1.0, 0.12, 0.82);
  pushCut(cuts, -0.28, 0.92, -0.22, 0.84);
  for (let c = 0; c < 3; c++) {
    const nx = hash3(c + seed, 1.1, 2.2) * 2 - 1;
    const ny = hash3(c + seed, 3.3, 4.4) * 2 - 1;
    const nz = hash3(c + seed, 5.5, 6.6) * 2 - 1;
    pushCut(cuts, nx, ny, nz, 0.72 + hash3(c + seed, 7.7, 8.8) * 0.22);
  }

  const p = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const cavityRel = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);

    // --- 1. Vertical teardrop: bulky upper half, narrow jagged tip ---
    p.x *= 0.9;
    p.y *= 1.52;
    p.z *= 0.86;
    const x1 = p.x + p.y * 0.07;
    const y1 = p.y - p.x * 0.04;
    const z1 = p.z + p.x * 0.05;
    const mass =
      1 +
      0.2 * Math.max(0, y1 * 0.42) +
      0.1 * fbm(x1 * 0.55 + seed, y1 * 0.4, z1 * 0.55, 3);
    p.set(x1 * mass, y1 * mass, z1 * (0.94 + 0.07 * mass));

    dir.copy(p);
    const plen = dir.length() || 1;
    dir.multiplyScalar(1 / plen);

    // --- 2. Domain warp; ridged noise stretched vertically so folds run up/down ---
    const wx = fbm(p.x * 0.9 + seed, p.y * 0.55, p.z * 0.9, 4) * 0.48;
    const wy = fbm(p.x * 0.9 + 17, p.y * 0.55 + seed, p.z * 0.9, 4) * 0.32;
    const wz = fbm(p.x * 0.9, p.y * 0.55 + 29, p.z * 0.9 + seed, 4) * 0.48;
    const qx = p.x + wx;
    const qy = p.y + wy;
    const qz = p.z + wz;

    const ridges = ridged(qx * 1.38 + seed, qy * 0.62, qz * 1.38, 5);
    const broad = fbm(qx * 0.65 + seed * 2, qy * 0.4, qz * 0.65, 4);
    const fine = fbm(qx * 3.05, qy * 1.55 + seed, qz * 3.05, 3);
    const crevice = creviceMask(qx, qy * 0.7, qz, 1.15, seed);

    let r = 0.72 + ridges * 0.42 + broad * 0.14 + fine * 0.08 - crevice * 0.16;

    // Wide at upper-mid, pinch toward the bottom tip; slight flatten at the peak.
    const yN = dir.y;
    const bottom = THREE.MathUtils.smootherstep(yN, -1, 0.08);
    const topPinch = THREE.MathUtils.smootherstep(yN, 0.55, 1);
    r *= THREE.MathUtils.lerp(0.4, 1.05, bottom) * (1 - 0.12 * topPinch);
    r = Math.max(0.38, r);

    p.copy(dir).multiplyScalar(r);

    // --- 3. Front/lower ellipsoid gouge — deep bowl, noisy rim so it isn't a circle ---
    cavityRel.set((p.x - 0.48) / 0.56, (p.y + 0.2) / 0.46, (p.z - 0.05) / 0.5);
    const cavityDist = cavityRel.length();
    const rimJitter =
      fbm(p.x * 5.2 + seed, p.y * 5.2, p.z * 5.2, 3) * 0.14 +
      ridged(p.x * 3.4, p.y * 3.4 + seed, p.z * 3.4, 2) * 0.08;
    const cavityOuter = 1.08 + rimJitter;
    if (cavityDist < cavityOuter) {
      const t = 1 - cavityDist / cavityOuter;
      const bowl = t * t * t;
      const depth = bowl * 0.82;
      p.x -= depth;
      p.y += cavityRel.y * depth * 0.14;
      p.z += cavityRel.z * depth * 0.2;
    }

    // --- 4. Hard planar clips with noise-broken lips (cleaved faces, not feathered) ---
    for (const cut of cuts) {
      const side = p.x * cut.nx + p.y * cut.ny + p.z * cut.nz;
      const jagged =
        cut.d +
        fbm(p.x * 3.4 + seed, p.y * 2.2, p.z * 3.4, 3) * 0.1 +
        ridged(p.x * 2.6, p.y * 1.6 + seed, p.z * 2.6, 2) * 0.07;
      if (side > jagged) {
        const excess = side - jagged;
        p.x -= cut.nx * excess;
        p.y -= cut.ny * excess;
        p.z -= cut.nz * excess;
      }
    }

    // Bake Poly Haven displacement as real surface relief (UVs match texture.repeat).
    const u = uv.getX(i) * TEX_REPEAT;
    const v = uv.getY(i) * TEX_REPEAT;
    const h = sampleDisplacement(data, width, height, u, v);
    const outward = p.length() || 1;
    const relief =
      (h - 0.5) * 0.28 +
      ridged(p.x * 4.5 + seed, p.y * 2.4, p.z * 4.5, 3) * 0.07 -
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
    geo.computeBoundingSphere();
  }

  // Welded (indexed) mesh can't fix the azimuth UV seam — one vert can't hold both
  // u≈0 and u≈1. Split to non-indexed after positions are final (duplicate corners
  // share the same position → still watertight) and unwrap like PolyhedronGeometry.
  const textured = geo.toNonIndexed();
  geo.dispose();
  correctUvSeams(textured);
  textured.computeVertexNormals();
  textured.computeBoundingSphere();

  return textured;
}

export function createRockMaterial(
  textures: RockTextures,
): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: textures.map,
    normalMap: textures.normalMap,
    normalScale: new THREE.Vector2(1.6, 1.6),
    roughnessMap: textures.roughnessMap,
    roughness: 1,
    metalnessMap: textures.metalnessMap,
    metalness: 1, // scratched-gold flecks from metalnessMap catch studio lights
    aoMap: textures.aoMap,
    aoMapIntensity: 1.5,
    clearcoat: 0,
    // Almost no IBL on charcoal; facets stay matte so fill/rim don't wash the far side.
    envMapIntensity: 0.04,
    specularIntensity: 0.2,
  });
}

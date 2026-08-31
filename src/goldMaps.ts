import * as THREE from "three";

/**
 * Scratched-metal gold from the hibbary collage strip.
 * Rock ore compositing and crystal Citrine both sample the same strip so flecks
 * and facets share one metal look.
 */

const GOLD_COLLAGE_URL = "/textures/gold_texture.webp";

/** Strip 4 of 6 (0-based) — bright yellow-gold leaf. */
const GOLD_STRIP_INDEX = 3;
const STRIP_COUNT = 6;

/** UV tile rate when sampling into rock flecks — keeps micro-scratches sharp at 1024. */
const GOLD_TILE = 6;

/** Gold roughness in 0–255 (≈0.16–0.22). */
const GOLD_ROUGH = 48;
const ROCK_ROUGH = 240;

/** Charcoal albedo scale — keeps stone dark next to gold flecks. */
export const CHARCOAL_ALBEDO = 0.1;

export interface GoldStrip {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

function canvasTex(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = colorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Crop one vertical swatch from the 6-strip collage into pixel data. */
function extractGoldStrip(
  img: HTMLImageElement | ImageBitmap,
  stripIndex = GOLD_STRIP_INDEX,
): GoldStrip {
  const stripW = Math.floor(img.width / STRIP_COUNT);
  const stripH = img.height;
  const canvas = document.createElement("canvas");
  canvas.width = stripW;
  canvas.height = stripH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not extract gold strip");
  ctx.drawImage(
    img,
    stripIndex * stripW,
    0,
    stripW,
    stripH,
    0,
    0,
    stripW,
    stripH,
  );
  const { data, width, height } = ctx.getImageData(0, 0, stripW, stripH);
  return { data: new Uint8ClampedArray(data), width, height };
}

export async function loadGoldStrip(): Promise<GoldStrip> {
  const tex = await new THREE.TextureLoader().loadAsync(GOLD_COLLAGE_URL);
  const strip = extractGoldStrip(tex.image as HTMLImageElement | ImageBitmap);
  tex.dispose();
  return strip;
}

/** Wrap-sampling scratched metal RGB from the strip. */
function sampleGoldStrip(
  strip: GoldStrip,
  u: number,
  v: number,
): [number, number, number] {
  const uu = ((u % 1) + 1) % 1;
  const vv = ((v % 1) + 1) % 1;
  const x = Math.min(strip.width - 1, Math.floor(uu * strip.width));
  const y = Math.min(strip.height - 1, Math.floor(vv * strip.height));
  const i = (y * strip.width + x) * 4;
  return [strip.data[i]!, strip.data[i + 1]!, strip.data[i + 2]!];
}

/**
 * Hard ore mask — stricter than the soft painted flecks so edges don't bleed
 * into charcoal.
 */
function isWarmOre(r: number, g: number, b: number): boolean {
  return r > g && g >= b && r - b > 48 && r > 72 && r / Math.max(g, 1) > 1.08;
}

/** Sample a grayscale roughness map (R channel) at albedo UV, scaled into rock range. */
function sampleRockRoughness(
  roughSrc: Uint8ClampedArray | null,
  roughW: number,
  roughH: number,
  x: number,
  y: number,
  albedoW: number,
  albedoH: number,
): number {
  if (!roughSrc || roughW <= 0 || roughH <= 0) return ROCK_ROUGH;
  const rx = Math.min(roughW - 1, Math.floor((x / albedoW) * roughW));
  const ry = Math.min(roughH - 1, Math.floor((y / albedoH) * roughH));
  const sample = roughSrc[(ry * roughW + rx) * 4]! / 255;
  // Map Poly Haven roughness into a high-dielectric band around ROCK_ROUGH.
  return Math.round(200 + sample * 55);
}

/**
 * Sharpen rock albedo, replace warm flecks with tiled scratched gold, and build
 * matching metalness / roughness maps. Optional Poly Haven roughness drives
 * charcoal grit; gold flecks keep scratched-leaf roughness.
 *
 * Sources larger than MAX_COMPOSITE_SIZE (e.g. 8K authoring maps) are downsampled
 * before CPU compositing so getImageData stays browser-safe.
 */
const MAX_COMPOSITE_SIZE = 2048;

export function compositeRockAlbedoWithGold(
  source: THREE.Texture,
  goldStrip: GoldStrip,
  roughnessSource?: THREE.Texture,
): {
  map: THREE.CanvasTexture;
  metalnessMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
} {
  const img = source.image as HTMLImageElement | ImageBitmap;
  const scale = Math.min(
    1,
    MAX_COMPOSITE_SIZE / Math.max(img.width, img.height),
  );
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const albedoCanvas = document.createElement("canvas");
  albedoCanvas.width = w;
  albedoCanvas.height = h;
  const aCtx = albedoCanvas.getContext("2d", { willReadFrequently: true });
  if (!aCtx) throw new Error("Could not process rock albedo");
  aCtx.drawImage(img, 0, 0, w, h);
  const image = aCtx.getImageData(0, 0, w, h);
  const src = image.data;
  const copy = new Uint8ClampedArray(src);

  let roughSrc: Uint8ClampedArray | null = null;
  let roughW = 0;
  let roughH = 0;
  if (roughnessSource) {
    const rImg = roughnessSource.image as HTMLImageElement | ImageBitmap;
    roughW = rImg.width;
    roughH = rImg.height;
    const tmp = document.createElement("canvas");
    tmp.width = roughW;
    tmp.height = roughH;
    const tCtx = tmp.getContext("2d", { willReadFrequently: true });
    if (!tCtx) throw new Error("Could not sample rock roughness map");
    tCtx.drawImage(rImg, 0, 0);
    roughSrc = new Uint8ClampedArray(
      tCtx.getImageData(0, 0, roughW, roughH).data,
    );
    roughnessSource.dispose();
  }

  const metalCanvas = document.createElement("canvas");
  metalCanvas.width = w;
  metalCanvas.height = h;
  const mCtx = metalCanvas.getContext("2d")!;
  const metalImage = mCtx.createImageData(w, h);
  const metal = metalImage.data;

  const roughCanvas = document.createElement("canvas");
  roughCanvas.width = w;
  roughCanvas.height = h;
  const rCtx = roughCanvas.getContext("2d")!;
  const roughImage = rCtx.createImageData(w, h);
  const rough = roughImage.data;

  // Pass 1: unsharp charcoal so stone grain stays readable next to hard gold edges.
  const amount = 1.55;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const center = copy[i + c]!;
        const blur =
          (copy[((y - 1) * w + x) * 4 + c]! +
            copy[((y + 1) * w + x) * 4 + c]! +
            copy[(y * w + (x - 1)) * 4 + c]! +
            copy[(y * w + (x + 1)) * 4 + c]! +
            center) /
          5;
        src[i + c] = Math.min(
          255,
          Math.max(0, Math.round(center + (center - blur) * amount)),
        );
      }
    }
  }

  // Pass 2: warm mask → scratched gold; charcoal darkens and stays dielectric.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = src[i]!;
      const g = src[i + 1]!;
      const b = src[i + 2]!;
      const warm = isWarmOre(r, g, b);

      if (warm) {
        const [gr, gg, gb] = sampleGoldStrip(
          goldStrip,
          (x / w) * GOLD_TILE,
          (y / h) * GOLD_TILE,
        );
        // Slight lift so leaf gold reads against charcoal under ACES.
        src[i] = Math.min(255, Math.round(gr * 1.08 + 8));
        src[i + 1] = Math.min(255, Math.round(gg * 1.05 + 4));
        src[i + 2] = Math.min(255, Math.round(gb * 0.95));
        metal[i] = metal[i + 1] = metal[i + 2] = 255;
        // Darker scratches in the strip → slightly rougher metal.
        const scratch = 1 - (gr * 0.299 + gg * 0.587 + gb * 0.114) / 255;
        const roughVal = Math.round(GOLD_ROUGH + scratch * 28);
        rough[i] = rough[i + 1] = rough[i + 2] = roughVal;
      } else {
        src[i] = Math.round(r * CHARCOAL_ALBEDO);
        src[i + 1] = Math.round(g * CHARCOAL_ALBEDO);
        src[i + 2] = Math.round(b * CHARCOAL_ALBEDO);
        metal[i] = metal[i + 1] = metal[i + 2] = 0;
        const rockRough = sampleRockRoughness(
          roughSrc,
          roughW,
          roughH,
          x,
          y,
          w,
          h,
        );
        rough[i] = rough[i + 1] = rough[i + 2] = rockRough;
      }
      metal[i + 3] = 255;
      rough[i + 3] = 255;
    }
  }

  // Pass 3: local contrast only on gold / charcoal boundaries so fleck silhouettes snap.
  const after = new Uint8ClampedArray(src);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      if (metal[i]! < 128) continue;
      let neighborRock = false;
      for (const [dx, dy] of [
        [0, -1],
        [0, 1],
        [-1, 0],
        [1, 0],
      ] as const) {
        if (metal[((y + dy) * w + (x + dx)) * 4]! < 128) {
          neighborRock = true;
          break;
        }
      }
      if (!neighborRock) continue;
      for (let c = 0; c < 3; c++) {
        const center = after[i + c]!;
        src[i + c] = Math.min(255, Math.round(center * 1.12 + 6));
      }
    }
  }

  aCtx.putImageData(image, 0, 0);
  mCtx.putImageData(metalImage, 0, 0);
  rCtx.putImageData(roughImage, 0, 0);
  source.dispose();

  return {
    map: canvasTex(albedoCanvas, THREE.SRGBColorSpace),
    metalnessMap: canvasTex(metalCanvas, THREE.NoColorSpace),
    roughnessMap: canvasTex(roughCanvas, THREE.NoColorSpace),
  };
}

/**
 * Same CPU path as the paint-scene rock albedo (unsharp + charcoal scale) but every
 * pixel stays dielectric — warm ore flecks darken instead of swapping to gold.
 */
export function buildCharcoalRockMaps(
  source: THREE.Texture,
  roughnessSource?: THREE.Texture,
): {
  map: THREE.CanvasTexture;
  metalnessMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
} {
  const img = source.image as HTMLImageElement | ImageBitmap;
  const scale = Math.min(
    1,
    MAX_COMPOSITE_SIZE / Math.max(img.width, img.height),
  );
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const albedoCanvas = document.createElement("canvas");
  albedoCanvas.width = w;
  albedoCanvas.height = h;
  const aCtx = albedoCanvas.getContext("2d", { willReadFrequently: true });
  if (!aCtx) throw new Error("Could not process rock albedo");
  aCtx.drawImage(img, 0, 0, w, h);
  const image = aCtx.getImageData(0, 0, w, h);
  const src = image.data;
  const copy = new Uint8ClampedArray(src);

  let roughSrc: Uint8ClampedArray | null = null;
  let roughW = 0;
  let roughH = 0;
  if (roughnessSource) {
    const rImg = roughnessSource.image as HTMLImageElement | ImageBitmap;
    roughW = rImg.width;
    roughH = rImg.height;
    const tmp = document.createElement("canvas");
    tmp.width = roughW;
    tmp.height = roughH;
    const tCtx = tmp.getContext("2d", { willReadFrequently: true });
    if (!tCtx) throw new Error("Could not sample rock roughness map");
    tCtx.drawImage(rImg, 0, 0);
    roughSrc = new Uint8ClampedArray(
      tCtx.getImageData(0, 0, roughW, roughH).data,
    );
    roughnessSource.dispose();
  }

  const metalCanvas = document.createElement("canvas");
  metalCanvas.width = w;
  metalCanvas.height = h;
  const mCtx = metalCanvas.getContext("2d")!;
  const metalImage = mCtx.createImageData(w, h);
  const metal = metalImage.data;

  const roughCanvas = document.createElement("canvas");
  roughCanvas.width = w;
  roughCanvas.height = h;
  const rCtx = roughCanvas.getContext("2d")!;
  const roughImage = rCtx.createImageData(w, h);
  const rough = roughImage.data;

  const amount = 1.55;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const center = copy[i + c]!;
        const blur =
          (copy[((y - 1) * w + x) * 4 + c]! +
            copy[((y + 1) * w + x) * 4 + c]! +
            copy[(y * w + (x - 1)) * 4 + c]! +
            copy[(y * w + (x + 1)) * 4 + c]! +
            center) /
          5;
        src[i + c] = Math.min(
          255,
          Math.max(0, Math.round(center + (center - blur) * amount)),
        );
      }
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      src[i] = Math.round(src[i]! * CHARCOAL_ALBEDO);
      src[i + 1] = Math.round(src[i + 1]! * CHARCOAL_ALBEDO);
      src[i + 2] = Math.round(src[i + 2]! * CHARCOAL_ALBEDO);
      metal[i] = metal[i + 1] = metal[i + 2] = 0;
      const rockRough = sampleRockRoughness(
        roughSrc,
        roughW,
        roughH,
        x,
        y,
        w,
        h,
      );
      rough[i] = rough[i + 1] = rough[i + 2] = rockRough;
      metal[i + 3] = 255;
      rough[i + 3] = 255;
    }
  }

  aCtx.putImageData(image, 0, 0);
  mCtx.putImageData(metalImage, 0, 0);
  rCtx.putImageData(roughImage, 0, 0);
  source.dispose();

  return {
    map: canvasTex(albedoCanvas, THREE.SRGBColorSpace),
    metalnessMap: canvasTex(metalCanvas, THREE.NoColorSpace),
    roughnessMap: canvasTex(roughCanvas, THREE.NoColorSpace),
  };
}

export interface GoldRockMaps {
  map: THREE.Texture;
  roughnessMap: THREE.Texture;
}

let goldRockMapsPromise: Promise<GoldRockMaps> | null = null;

/** Load scratched-gold maps once for full-gold satellite rocks. */
export function prepareGoldRockMaps(): Promise<GoldRockMaps> {
  if (!goldRockMapsPromise) {
    goldRockMapsPromise = loadGoldStrip().then((strip) =>
      buildCrystalGoldMaps(strip),
    );
  }
  return goldRockMapsPromise;
}

/** Fully metallic gold material for satellite rocks in the cluster scene. */
export function createGoldRockMaterial(
  maps: GoldRockMaps,
  opts: { normalMap?: THREE.Texture; envMapIntensity?: number } = {},
): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: maps.map,
    roughnessMap: maps.roughnessMap,
    roughness: 1,
    metalness: 1,
    normalMap: opts.normalMap,
    normalScale: opts.normalMap ? new THREE.Vector2(1.2, 1.2) : undefined,
    envMapIntensity: opts.envMapIntensity ?? 1.0,
    clearcoat: 0.05,
    clearcoatRoughness: 0.35,
  });
}

/**
 * Solid scratched-gold albedo + roughness for metallic crystals.
 * Same strip as rock flecks; tiled so facets show leaf grain.
 */
export function buildCrystalGoldMaps(
  goldStrip: GoldStrip,
  size = 1024,
  tile = 2.2,
): {
  map: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
} {
  const albedo = document.createElement("canvas");
  albedo.width = size;
  albedo.height = size;
  const aCtx = albedo.getContext("2d", { willReadFrequently: true });
  if (!aCtx) throw new Error("Could not build crystal gold albedo");
  const image = aCtx.createImageData(size, size);
  const src = image.data;

  const roughData = new Uint8ClampedArray(src.length);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const [gr, gg, gb] = sampleGoldStrip(
        goldStrip,
        (x / size) * tile,
        (y / size) * tile,
      );
      src[i] = Math.min(255, Math.round(gr * 1.06 + 6));
      src[i + 1] = Math.min(255, Math.round(gg * 1.03 + 3));
      src[i + 2] = Math.min(255, Math.round(gb * 0.94));
      src[i + 3] = 255;

      const scratch = 1 - (gr * 0.299 + gg * 0.587 + gb * 0.114) / 255;
      const roughVal = Math.round(40 + scratch * 55);
      roughData[i] = roughData[i + 1] = roughData[i + 2] = roughVal;
      roughData[i + 3] = 255;
    }
  }
  aCtx.putImageData(image, 0, 0);

  const roughCanvas = document.createElement("canvas");
  roughCanvas.width = size;
  roughCanvas.height = size;
  const rCtx = roughCanvas.getContext("2d");
  if (!rCtx) throw new Error("Could not build gold roughness map");
  rCtx.putImageData(new ImageData(roughData, size, size), 0, 0);

  const map = canvasTex(albedo, THREE.SRGBColorSpace);
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(1.4, 1.4);
  map.anisotropy = 16;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.magFilter = THREE.LinearFilter;

  const roughnessMap = canvasTex(roughCanvas, THREE.NoColorSpace);
  roughnessMap.wrapS = THREE.RepeatWrapping;
  roughnessMap.wrapT = THREE.RepeatWrapping;
  roughnessMap.repeat.copy(map.repeat);
  roughnessMap.anisotropy = 16;
  roughnessMap.minFilter = THREE.LinearMipmapLinearFilter;
  roughnessMap.magFilter = THREE.LinearFilter;

  return { map, roughnessMap };
}

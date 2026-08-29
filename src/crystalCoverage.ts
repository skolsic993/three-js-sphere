import * as THREE from "three";
import { mulberry32, type SurfaceSample } from "./modes/mode";

/**
 * Random crystal coverage for a rock mesh.
 *
 * `coverage` is 0..1: the fraction of the rock surface to fill with crystal
 * clusters. 0.65 ≈ 65% packed footprints. Count is derived from mesh area and
 * cluster footprint (crystalSize × spread), so the same percentage reads similarly
 * across rock sizes — suitable as a monorepo/API dial.
 *
 * Samples are taken on triangle faces (not vertices) with outward face normals so
 * clusters sit on the visible surface instead of drifting off bad averaged normals.
 */

export interface CrystalCoverageOpts {
  /** Fraction of surface to cover (0 = bare, 1 = packed). */
  coverage: number;
  seed: number;
  crystalSize: number;
  spread: number;
  /**
   * Only seed faces whose normal points somewhat upward.
   * Useful for small scenery rocks; leave false for the main specimen.
   */
  upperHemisphereOnly?: boolean;
}

interface SurfaceFace {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  cx: number;
  cy: number;
  cz: number;
  nx: number;
  ny: number;
  nz: number;
  area: number;
  cdf: number; // cumulative area for weighted picks
}

/** Approximate surface area from triangle cross-products (fallback: sphere). */
export function estimateSurfaceArea(geo: THREE.BufferGeometry): number {
  const faces = buildOutwardFaces(geo);
  if (faces.length === 0) {
    geo.computeBoundingSphere();
    const r = geo.boundingSphere?.radius ?? 1;
    return 4 * Math.PI * r * r;
  }
  return faces[faces.length - 1]!.cdf;
}

/**
 * How many clusters "coverage" implies for this rock and crystal footprint.
 * Footprint is treated as a disk of radius ≈ crystalSize * spread * 0.55.
 * Capped so dense rocks stay interactive while still reading as full at 100%.
 */
export function clusterCountForCoverage(
  surfaceArea: number,
  coverage: number,
  crystalSize: number,
  spread: number,
): number {
  const t = THREE.MathUtils.clamp(coverage, 0, 1);
  if (t <= 0) return 0;
  const radius = Math.max(crystalSize * spread * 0.55, 0.03);
  const footprint = Math.PI * radius * radius;
  // Slight overlap allowance so 100% still reads full without absurd counts.
  const packed = Math.max(1, Math.floor(surfaceArea / (footprint * 0.9)));
  // Hard cap: each cluster allocates many shard slots; keep rebuilds snappy.
  const MAX_CLUSTERS = 180;
  return Math.max(1, Math.min(MAX_CLUSTERS, Math.round(t * packed)));
}

/**
 * Pick unique surface points that roughly fill `coverage` of the rock.
 * Area-weighted triangle samples + outward face normals keep crystals glued on.
 */
export function sampleRockSurfaceByCoverage(
  geo: THREE.BufferGeometry,
  opts: CrystalCoverageOpts,
): SurfaceSample[] {
  const rnd = mulberry32(opts.seed);
  const faces = buildOutwardFaces(geo);
  if (faces.length === 0) return [];

  const totalArea = faces[faces.length - 1]!.cdf;
  const target = clusterCountForCoverage(
    totalArea,
    opts.coverage,
    opts.crystalSize,
    opts.spread,
  );
  if (target <= 0) return [];

  const eligible = opts.upperHemisphereOnly
    ? faces.filter((f) => f.ny > 0.15)
    : faces;
  const pool = eligible.length > 0 ? eligible : faces;

  // Fresh CDF over the active pool (filtered faces keep stale cumulative values).
  const cdf: number[] = new Array(pool.length);
  let run = 0;
  for (let i = 0; i < pool.length; i++) {
    run += pool[i]!.area;
    cdf[i] = run;
  }
  if (run <= 1e-12) return [];

  const minDist =
    Math.max(opts.crystalSize * opts.spread * 0.7, 0.04) * (0.85 + rnd() * 0.2);
  const minDistSq = minDist * minDist;

  const samples: SurfaceSample[] = [];
  const px: number[] = [];
  const py: number[] = [];
  const pz: number[] = [];

  // Extra attempts: min-distance rejects some picks on a busy surface.
  const maxAttempts = target * 24;
  for (
    let attempt = 0;
    attempt < maxAttempts && samples.length < target;
    attempt++
  ) {
    const face = pickFace(pool, cdf, run, rnd);
    const point = randomPointOnFace(face, rnd);

    let ok = true;
    for (let k = 0; k < samples.length; k++) {
      const dx = point.x - px[k]!;
      const dy = point.y - py[k]!;
      const dz = point.z - pz[k]!;
      if (dx * dx + dy * dy + dz * dz < minDistSq) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const local = point;
    const localNormal = new THREE.Vector3(face.nx, face.ny, face.nz);
    samples.push({
      position: local.clone(),
      normal: localNormal.clone(),
      local,
      localNormal,
    });
    px.push(local.x);
    py.push(local.y);
    pz.push(local.z);
  }

  return samples;
}

/** Build triangles with area and outward-facing normals (away from mesh centroid). */
function buildOutwardFaces(geo: THREE.BufferGeometry): SurfaceFace[] {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const idx = geo.getIndex();

  geo.computeBoundingBox();
  const center = new THREE.Vector3();
  geo.boundingBox?.getCenter(center);

  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const n = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const faces: SurfaceFace[] = [];
  let cdf = 0;

  const push = (ia: number, ib: number, ic: number): void => {
    const ax = pos.getX(ia);
    const ay = pos.getY(ia);
    const az = pos.getZ(ia);
    const bx = pos.getX(ib);
    const by = pos.getY(ib);
    const bz = pos.getZ(ib);
    const cx = pos.getX(ic);
    const cy = pos.getY(ic);
    const cz = pos.getZ(ic);

    ab.set(bx - ax, by - ay, bz - az);
    ac.set(cx - ax, cy - ay, cz - az);
    n.copy(ab).cross(ac);
    const twiceArea = n.length();
    if (twiceArea < 1e-12) return;
    n.multiplyScalar(1 / twiceArea);

    // Flip if the winding faces the centroid (inward).
    mid.set(
      (ax + bx + cx) / 3 - center.x,
      (ay + by + cy) / 3 - center.y,
      (az + bz + cz) / 3 - center.z,
    );
    if (n.dot(mid) < 0) n.negate();

    const area = twiceArea * 0.5;
    cdf += area;
    faces.push({
      ax,
      ay,
      az,
      bx,
      by,
      bz,
      cx,
      cy,
      cz,
      nx: n.x,
      ny: n.y,
      nz: n.z,
      area,
      cdf,
    });
  };

  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      push(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2));
    }
  } else {
    for (let i = 0; i < pos.count; i += 3) {
      push(i, i + 1, i + 2);
    }
  }

  return faces;
}

function pickFace(
  faces: SurfaceFace[],
  cdf: number[],
  totalArea: number,
  rnd: () => number,
): SurfaceFace {
  const t = rnd() * totalArea;
  let lo = 0;
  let hi = faces.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return faces[lo]!;
}

/** Uniform barycentric sample on a triangle. */
function randomPointOnFace(
  face: SurfaceFace,
  rnd: () => number,
): THREE.Vector3 {
  let u = rnd();
  let v = rnd();
  if (u + v > 1) {
    u = 1 - u;
    v = 1 - v;
  }
  const w = 1 - u - v;
  return new THREE.Vector3(
    face.ax * w + face.bx * u + face.cx * v,
    face.ay * w + face.by * u + face.cy * v,
    face.az * w + face.bz * u + face.cz * v,
  );
}

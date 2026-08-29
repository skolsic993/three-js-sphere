import * as THREE from "three";
import { mulberry32, type SurfaceSample } from "./modes/mode";

/**
 * Random crystal coverage for a rock mesh.
 *
 * `coverage` is 0..1. Mix of short surface veins + packed dots.
 * Samples triangles directly (no giant face list) so rebuild stays snappy
 * even on high-detail rocks.
 */

export interface CrystalCoverageOpts {
  /** Fraction of surface to cover (0 = bare, 1 = packed). */
  coverage: number;
  seed: number;
  crystalSize: number;
  spread: number;
  upperHemisphereOnly?: boolean;
}

export function estimateSurfaceArea(geo: THREE.BufferGeometry): number {
  geo.computeBoundingSphere();
  const r = geo.boundingSphere?.radius ?? 1;
  // Displaced rock ≈ sphere area; good enough for coverage packing.
  return 4 * Math.PI * r * r;
}

export function clusterCountForCoverage(
  surfaceArea: number,
  coverage: number,
  crystalSize: number,
  spread: number,
): number {
  const t = THREE.MathUtils.clamp(coverage, 0, 1);
  if (t <= 0) return 0;
  const radius = Math.max(crystalSize * spread * 0.3, 0.018);
  const footprint = Math.PI * radius * radius;
  const packed = Math.max(1, Math.floor(surfaceArea / (footprint * 0.5)));
  const MAX_CLUSTERS = 560;
  return Math.max(12, Math.min(MAX_CLUSTERS, Math.round(t * packed)));
}

/**
 * Coverage as vein paths + gap-filling dots. Always returns samples when coverage > 0.
 */
export function sampleRockCoverageVeins(
  geo: THREE.BufferGeometry,
  opts: CrystalCoverageOpts,
): SurfaceSample[][] {
  const rnd = mulberry32(opts.seed);
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const idx = geo.getIndex();
  const triCount = idx ? idx.count / 3 : Math.floor(pos.count / 3);
  if (triCount < 1) return [];

  geo.computeBoundingBox();
  const center = new THREE.Vector3();
  geo.boundingBox?.getCenter(center);

  const area = estimateSurfaceArea(geo);
  const target = clusterCountForCoverage(
    area,
    opts.coverage,
    opts.crystalSize,
    opts.spread,
  );

  const t = THREE.MathUtils.clamp(opts.coverage, 0, 1);
  const veinBudget = Math.max(6, Math.round(target * 0.5));
  const dotBudget = Math.max(6, target - veinBudget);
  const spacing = Math.max(opts.crystalSize * opts.spread * 0.2, 0.03);
  const veinCount = Math.max(4, Math.round(8 + t * 40));
  const perVein = Math.max(5, Math.ceil(veinBudget / veinCount));

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const n = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const p = new THREE.Vector3();

  const readTri = (
    tri: number,
  ): { ok: boolean; nx: number; ny: number; nz: number } => {
    const base = tri * 3;
    let ia: number;
    let ib: number;
    let ic: number;
    if (idx) {
      ia = idx.getX(base);
      ib = idx.getX(base + 1);
      ic = idx.getX(base + 2);
    } else {
      ia = base;
      ib = base + 1;
      ic = base + 2;
    }
    a.fromBufferAttribute(pos, ia);
    b.fromBufferAttribute(pos, ib);
    c.fromBufferAttribute(pos, ic);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    n.copy(ab).cross(ac);
    const len = n.length();
    if (len < 1e-12) return { ok: false, nx: 0, ny: 1, nz: 0 };
    n.multiplyScalar(1 / len);
    mid.set(
      (a.x + b.x + c.x) / 3 - center.x,
      (a.y + b.y + c.y) / 3 - center.y,
      (a.z + b.z + c.z) / 3 - center.z,
    );
    if (n.dot(mid) < 0) n.negate();
    if (opts.upperHemisphereOnly && n.y <= 0.1) {
      return { ok: false, nx: n.x, ny: n.y, nz: n.z };
    }
    return { ok: true, nx: n.x, ny: n.y, nz: n.z };
  };

  const pointOnTri = (): void => {
    let u = rnd();
    let v = rnd();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    const w = 1 - u - v;
    p.set(
      a.x * w + b.x * u + c.x * v,
      a.y * w + b.y * u + c.y * v,
      a.z * w + b.z * u + c.z * v,
    );
  };

  const pickTri = (): number => Math.floor(rnd() * triCount);

  const makeSample = (
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
  ): SurfaceSample => {
    const local = new THREE.Vector3(x, y, z);
    const localNormal = new THREE.Vector3(nx, ny, nz).normalize();
    return {
      position: local.clone(),
      normal: localNormal.clone(),
      local,
      localNormal,
    };
  };

  const occupied: THREE.Vector3[] = [];
  const tooClose = (x: number, y: number, z: number, minD: number): boolean => {
    const minDSq = minD * minD;
    for (const q of occupied) {
      const dx = x - q.x;
      const dy = y - q.y;
      const dz = z - q.z;
      if (dx * dx + dy * dy + dz * dz < minDSq) return true;
    }
    return false;
  };

  const sampleOne = (minD: number): SurfaceSample | null => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const tri = pickTri();
      const face = readTri(tri);
      if (!face.ok) continue;
      pointOnTri();
      if (tooClose(p.x, p.y, p.z, minD)) continue;
      const s = makeSample(p.x, p.y, p.z, face.nx, face.ny, face.nz);
      occupied.push(s.local);
      return s;
    }
    return null;
  };

  const veins: SurfaceSample[][] = [];

  // --- veins: crawl in the tangent plane, re-snap to nearby triangles ---
  for (let v = 0; v < veinCount; v++) {
    const start = sampleOne(spacing * 1.4);
    if (!start) continue;
    const vein: SurfaceSample[] = [start];

    const normal = start.localNormal.clone();
    let dir = new THREE.Vector3(1, 0, 0);
    if (Math.abs(normal.x) > 0.9) dir.set(0, 1, 0);
    dir.cross(normal).normalize();
    const spin = rnd() * Math.PI * 2;
    const bitangent = new THREE.Vector3().crossVectors(normal, dir);
    dir
      .multiplyScalar(Math.cos(spin))
      .addScaledVector(bitangent, Math.sin(spin))
      .normalize();

    const cursor = start.local.clone();
    const step = spacing * (0.65 + rnd() * 0.4);

    for (let i = 1; i < perVein; i++) {
      cursor
        .addScaledVector(dir, step)
        .addScaledVector(bitangent, (rnd() - 0.5) * step * 0.4);

      // Snap: try random tris, keep the closest centroid to cursor.
      let bestTri = -1;
      let bestDist = Infinity;
      for (let k = 0; k < 36; k++) {
        const tri = pickTri();
        const face = readTri(tri);
        if (!face.ok) continue;
        mid.set(
          (a.x + b.x + c.x) / 3,
          (a.y + b.y + c.y) / 3,
          (a.z + b.z + c.z) / 3,
        );
        const d = mid.distanceToSquared(cursor);
        if (d < bestDist) {
          bestDist = d;
          bestTri = tri;
        }
      }
      if (bestTri < 0) break;
      const face = readTri(bestTri);
      if (!face.ok) break;
      pointOnTri();
      cursor.lerp(p, 0.8);
      if (tooClose(cursor.x, cursor.y, cursor.z, spacing * 0.45)) {
        // Nudge along and keep trying — don't kill the whole vein.
        continue;
      }
      normal.set(face.nx, face.ny, face.nz);
      const s = makeSample(
        cursor.x,
        cursor.y,
        cursor.z,
        face.nx,
        face.ny,
        face.nz,
      );
      vein.push(s);
      occupied.push(s.local);

      dir.sub(normal.clone().multiplyScalar(dir.dot(normal)));
      if (dir.lengthSq() < 1e-6) {
        dir.set(1, 0, 0);
        if (Math.abs(normal.x) > 0.9) dir.set(0, 1, 0);
        dir.cross(normal);
      }
      dir.normalize();
      bitangent.crossVectors(normal, dir).normalize();
    }

    if (vein.length >= 3) veins.push(vein);
  }

  // --- packed dots between veins ---
  const dots: SurfaceSample[] = [];
  for (let i = 0; i < dotBudget * 25 && dots.length < dotBudget; i++) {
    const s = sampleOne(spacing * 0.75);
    if (s) dots.push(s);
  }
  if (dots.length > 0) veins.push(dots);

  if (veins.length === 0) {
    const emergency: SurfaceSample[] = [];
    for (let i = 0; i < target; i++) {
      const tri = pickTri();
      const face = readTri(tri);
      if (!face.ok) continue;
      pointOnTri();
      emergency.push(makeSample(p.x, p.y, p.z, face.nx, face.ny, face.nz));
    }
    if (emergency.length > 0) return [emergency];
  }

  return veins;
}

export function sampleRockSurfaceByCoverage(
  geo: THREE.BufferGeometry,
  opts: CrystalCoverageOpts,
): SurfaceSample[] {
  return sampleRockCoverageVeins(geo, opts).flat();
}

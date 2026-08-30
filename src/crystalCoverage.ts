import * as THREE from "three";
import { mulberry32, type SurfaceSample } from "./modes/mode";

/**
 * Random crystal coverage for a rock mesh.
 *
 * `coverage` is 0..1 of *visual* surface fill. Packing uses the crystal's
 * apparent patch size (≈ crystalSize), not the wide cluster-spread disk —
 * otherwise coverage=1 still looks ~10% covered.
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
  return 4 * Math.PI * r * r;
}

/**
 * How many clusters for this coverage.
 *
 * Cap is applied to the *100%* budget first, then multiplied by coverage —
 * so 0.6 is ~60% as many crystals as 1.0 (not the same count hitting a shared max).
 */
export function clusterCountForCoverage(
  surfaceArea: number,
  coverage: number,
  crystalSize: number,
  _spread: number,
): number {
  const t = THREE.MathUtils.clamp(coverage, 0, 1);
  if (t <= 0) return 0;
  // Visual patch ≈ main crystal width. Tight cell so coverage=1 reads as stacked ore.
  const radius = Math.max(crystalSize * 0.32, 0.01);
  const footprint = Math.PI * radius * radius;
  const MAX_AT_FULL = 8500;
  const fullPack = Math.min(
    MAX_AT_FULL,
    Math.max(1, Math.floor(surfaceArea / (footprint * 0.2))),
  );
  return Math.max(1, Math.round(t * fullPack));
}

/**
 * Coverage samples: thick veins + dense gap fill. Always returns samples when coverage > 0.
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
  // Vein vs dot split scales with the same linear budget.
  const veinBudget = Math.max(1, Math.round(target * 0.3));
  const dotBudget = Math.max(1, target - veinBudget);
  // Spacing matches visual patch — tight enough that coverage=1 looks full.
  const spacing = Math.max(opts.crystalSize * 0.3, 0.012);
  // Vein *count* also scales with coverage (not a flat 40–60 band).
  const veinCount = Math.max(1, Math.round(t * 55));
  const perVein = Math.max(3, Math.ceil(veinBudget / Math.max(1, veinCount)));

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const n = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const p = new THREE.Vector3();

  // Grid for O(1) proximity checks — linear scan dies at thousands of samples.
  const cell = spacing;
  const buckets = new Map<string, THREE.Vector3[]>();
  const keyOf = (x: number, y: number, z: number): string =>
    `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;

  const tooClose = (x: number, y: number, z: number, minD: number): boolean => {
    const minDSq = minD * minD;
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    const cz = Math.floor(z / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = buckets.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!list) continue;
          for (const q of list) {
            const ddx = x - q.x;
            const ddy = y - q.y;
            const ddz = z - q.z;
            if (ddx * ddx + ddy * ddy + ddz * ddz < minDSq) return true;
          }
        }
      }
    }
    return false;
  };

  const occupy = (v: THREE.Vector3): void => {
    const k = keyOf(v.x, v.y, v.z);
    let list = buckets.get(k);
    if (!list) {
      list = [];
      buckets.set(k, list);
    }
    list.push(v);
  };

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

  const sampleOne = (minD: number): SurfaceSample | null => {
    for (let attempt = 0; attempt < 96; attempt++) {
      const tri = pickTri();
      const face = readTri(tri);
      if (!face.ok) continue;
      pointOnTri();
      if (tooClose(p.x, p.y, p.z, minD)) continue;
      const s = makeSample(p.x, p.y, p.z, face.nx, face.ny, face.nz);
      occupy(s.local);
      return s;
    }
    return null;
  };

  const veins: SurfaceSample[][] = [];

  // --- veins ---
  for (let v = 0; v < veinCount; v++) {
    const start = sampleOne(spacing * 1.1);
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
    const step = spacing * (0.55 + rnd() * 0.35);

    for (let i = 1; i < perVein; i++) {
      cursor
        .addScaledVector(dir, step)
        .addScaledVector(bitangent, (rnd() - 0.5) * step * 0.45);

      let bestTri = -1;
      let bestDist = Infinity;
      for (let k = 0; k < 48; k++) {
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
      cursor.lerp(p, 0.85);
      if (tooClose(cursor.x, cursor.y, cursor.z, spacing * 0.4)) continue;

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
      occupy(s.local);

      // Side spur — thickens the seam.
      if (rnd() < 0.35) {
        const spur = cursor
          .clone()
          .addScaledVector(bitangent, (rnd() < 0.5 ? -1 : 1) * step * 0.7);
        if (!tooClose(spur.x, spur.y, spur.z, spacing * 0.35)) {
          const ss = makeSample(
            spur.x,
            spur.y,
            spur.z,
            face.nx,
            face.ny,
            face.nz,
          );
          vein.push(ss);
          occupy(ss.local);
        }
      }

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

  // --- dense dots (bulk of the coverage %) ---
  const dots: SurfaceSample[] = [];
  const dotAttempts = Math.max(dotBudget * 80, 4000);
  for (let i = 0; i < dotAttempts && dots.length < dotBudget; i++) {
    const s = sampleOne(spacing * 0.55);
    if (s) dots.push(s);
  }
  // If min-distance blocked us, relax and finish the budget so coverage=1 actually fills.
  if (dots.length < dotBudget * 0.9) {
    const need = dotBudget - dots.length;
    for (let i = 0; i < need * 50 && dots.length < dotBudget; i++) {
      const s = sampleOne(spacing * 0.28);
      if (s) dots.push(s);
    }
  }
  if (dots.length < dotBudget) {
    const need = dotBudget - dots.length;
    for (let i = 0; i < need * 40 && dots.length < dotBudget; i++) {
      const s = sampleOne(spacing * 0.16);
      if (s) dots.push(s);
    }
  }
  if (dots.length > 0) veins.push(dots);

  if (veins.length === 0) {
    const emergency: SurfaceSample[] = [];
    for (let i = 0; i < target; i++) {
      const tri = pickTri();
      const face = readTri(tri);
      if (!face.ok) continue;
      pointOnTri();
      const s = makeSample(p.x, p.y, p.z, face.nx, face.ny, face.nz);
      emergency.push(s);
      occupy(s.local);
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

import * as THREE from "three";
import { mulberry32 } from "./modes/mode";

/**
 * Gold dust veins nestled in rock crevices — continuous paths along concave surface
 * valleys, not floating scatter. Positions are rock-local.
 */

export function createGoldFlecks(
  rockGeo: THREE.BufferGeometry,
  opts: { veinCount?: number; seed?: number } = {},
): THREE.Points {
  const veinCount = opts.veinCount ?? 14;
  const rnd = mulberry32(opts.seed ?? 0x601d);

  rockGeo.computeVertexNormals();
  const pos = rockGeo.getAttribute("position") as THREE.BufferAttribute;
  const nrm = rockGeo.getAttribute("normal") as THREE.BufferAttribute;
  const n = pos.count;

  const cell = 0.1;
  const buckets = new Map<string, number[]>();
  const keyOf = (x: number, y: number, z: number): string =>
    `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;

  for (let i = 0; i < n; i++) {
    const k = keyOf(pos.getX(i), pos.getY(i), pos.getZ(i));
    let list = buckets.get(k);
    if (!list) {
      list = [];
      buckets.set(k, list);
    }
    list.push(i);
  }

  const neighbors: number[] = [];
  const near = (i: number): void => {
    neighbors.length = 0;
    const cx = Math.floor(pos.getX(i) / cell);
    const cy = Math.floor(pos.getY(i) / cell);
    const cz = Math.floor(pos.getZ(i) / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = buckets.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!list) continue;
          for (const j of list) {
            if (j !== i) neighbors.push(j);
          }
        }
      }
    }
  };

  // Crevice score: how recessed a vertex is vs its local neighborhood (high = valley).
  const crevice = new Float32Array(n);
  let creviceMax = 1e-6;
  for (let i = 0; i < n; i++) {
    near(i);
    if (neighbors.length < 3) {
      crevice[i] = 0;
      continue;
    }
    let ax = 0;
    let ay = 0;
    let az = 0;
    let count = 0;
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    for (const j of neighbors) {
      const dx = pos.getX(j) - px;
      const dy = pos.getY(j) - py;
      const dz = pos.getZ(j) - pz;
      if (dx * dx + dy * dy + dz * dz > cell * cell * 2.5) continue;
      ax += pos.getX(j);
      ay += pos.getY(j);
      az += pos.getZ(j);
      count++;
    }
    if (count < 3) {
      crevice[i] = 0;
      continue;
    }
    ax /= count;
    ay /= count;
    az /= count;
    // Neighbors average sits outward from a recessed vert → positive along normal.
    const score =
      (ax - px) * nrm.getX(i) +
      (ay - py) * nrm.getY(i) +
      (az - pz) * nrm.getZ(i);
    crevice[i] = Math.max(0, score);
    if (crevice[i]! > creviceMax) creviceMax = crevice[i]!;
  }
  for (let i = 0; i < n; i++) crevice[i]! /= creviceMax;

  // Start pool: only verts that sit in real crevices.
  const starts: number[] = [];
  for (let i = 0; i < n; i++) {
    if (crevice[i]! > 0.35) starts.push(i);
  }
  if (starts.length === 0) {
    for (let i = 0; i < n; i++) {
      if (crevice[i]! > 0.15) starts.push(i);
    }
  }

  const pts: number[] = [];
  const pushAt = (
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    sink: number,
    jitter: number,
  ): void => {
    // Sink slightly into the surface so flecks nestle in cracks, not float in space.
    const j = jitter * 0.5;
    pts.push(
      x + nx * sink + (rnd() - 0.5) * j,
      y + ny * sink + (rnd() - 0.5) * j,
      z + nz * sink + (rnd() - 0.5) * j,
    );
  };

  const pushVertex = (i: number, sink: number, jitter: number): void => {
    pushAt(
      pos.getX(i),
      pos.getY(i),
      pos.getZ(i),
      nrm.getX(i),
      nrm.getY(i),
      nrm.getZ(i),
      sink,
      jitter,
    );
  };

  /** Dense samples along the edge between two verts — makes a continuous path. */
  const pushEdge = (a: number, b: number, density: number): void => {
    const steps = Math.max(2, Math.floor(density));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      // Occasional gaps so veins thin out like the reference (not a solid rope).
      if (s > 0 && s < steps && rnd() < 0.14) continue;
      const x = pos.getX(a) * (1 - t) + pos.getX(b) * t;
      const y = pos.getY(a) * (1 - t) + pos.getY(b) * t;
      const z = pos.getZ(a) * (1 - t) + pos.getZ(b) * t;
      const nx = nrm.getX(a) * (1 - t) + nrm.getX(b) * t;
      const ny = nrm.getY(a) * (1 - t) + nrm.getY(b) * t;
      const nz = nrm.getZ(a) * (1 - t) + nrm.getZ(b) * t;
      const len = Math.hypot(nx, ny, nz) || 1;
      pushAt(
        x,
        y,
        z,
        nx / len,
        ny / len,
        nz / len,
        -0.002 + rnd() * 0.004,
        0.004,
      );
      // Hotspot clusters along the path.
      if (rnd() < 0.18) {
        pushAt(x, y, z, nx / len, ny / len, nz / len, -0.001, 0.008);
        pushAt(x, y, z, nx / len, ny / len, nz / len, 0.001, 0.01);
      }
    }
  };

  const pickStart = (): number => {
    if (starts.length === 0) return Math.floor(rnd() * n);
    // Weighted toward deeper crevices.
    for (let attempt = 0; attempt < 8; attempt++) {
      const i = starts[Math.floor(rnd() * starts.length)]!;
      if (rnd() < crevice[i]! * crevice[i]!) return i;
    }
    return starts[Math.floor(rnd() * starts.length)]!;
  };

  const walkVein = (start: number, maxSteps: number): void => {
    let cur = start;
    let prev = -1;
    for (let step = 0; step < maxSteps; step++) {
      near(cur);
      if (neighbors.length === 0) break;

      let best = -1;
      let bestScore = -Infinity;
      const px = prev < 0 ? pos.getX(cur) : pos.getX(prev);
      const py = prev < 0 ? pos.getY(cur) : pos.getY(prev);
      const pz = prev < 0 ? pos.getZ(cur) : pos.getZ(prev);
      const fx = pos.getX(cur) - px;
      const fy = pos.getY(cur) - py;
      const fz = pos.getZ(cur) - pz;

      for (const j of neighbors) {
        if (j === prev) continue;
        const dx = pos.getX(j) - pos.getX(cur);
        const dy = pos.getY(j) - pos.getY(cur);
        const dz = pos.getZ(j) - pos.getZ(cur);
        const dist2 = dx * dx + dy * dy + dz * dz;
        if (dist2 > cell * cell * 4) continue;
        const forward = dx * fx + dy * fy + dz * fz;
        // Strongly prefer staying in crevices so paths follow valleys.
        const score =
          crevice[j]! * 4.5 +
          Math.max(0, forward) * 1.2 -
          Math.sqrt(dist2) * 0.5 +
          rnd() * 0.15;
        if (score > bestScore) {
          bestScore = score;
          best = j;
        }
      }
      if (best < 0) break;

      // Skip ridges: if next is barely a crevice, thin out or stop the vein.
      if (crevice[best]! < 0.12 && step > 3) {
        if (rnd() < 0.65) break;
      }

      const density = 3 + crevice[cur]! * 5 + crevice[best]! * 4;
      pushEdge(cur, best, density);

      // Occasional short branch into a side crevice.
      if (rnd() < 0.12 && crevice[cur]! > 0.4) {
        near(cur);
        let branch = -1;
        let branchScore = -Infinity;
        for (const j of neighbors) {
          if (j === best || j === prev) continue;
          const s = crevice[j]! + rnd() * 0.1;
          if (s > branchScore) {
            branchScore = s;
            branch = j;
          }
        }
        if (branch >= 0 && crevice[branch]! > 0.25) {
          pushEdge(cur, branch, 2 + crevice[branch]! * 3);
        }
      }

      prev = cur;
      cur = best;
    }
  };

  for (let v = 0; v < veinCount; v++) {
    walkVein(pickStart(), 14 + Math.floor(rnd() * 28));
  }

  // Sparse secondary flecks only in deep crevices — no random surface scatter, no loft.
  for (let i = 0; i < n; i++) {
    if (crevice[i]! < 0.55) continue;
    if (rnd() > crevice[i]! * 0.08) continue;
    pushVertex(i, -0.001, 0.006);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));

  const mat = new THREE.PointsMaterial({
    color: 0xffe08a,
    size: 0.016,
    sizeAttenuation: true,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false, // stay bright against the dark studio / ACES curve
  });

  const points = new THREE.Points(geo, mat);
  geo.computeBoundingSphere();
  return points;
}

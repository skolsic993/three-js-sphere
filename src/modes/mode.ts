import * as THREE from "three";

export interface SurfaceSample {
  position: THREE.Vector3;
  normal: THREE.Vector3;
  local: THREE.Vector3;
  localNormal: THREE.Vector3;
}

export interface StrokeInstance {
  group: THREE.Group;
  update(dt: number, time: number): void;
  finishGrowth(): void;
  applySettings?(settings: unknown): void;
  dispose(): void;
}

export interface PaintMode<S = unknown> {
  readonly id: string;
  createStroke(
    samples: SurfaceSample[],
    seed: number,
    settings: S,
  ): StrokeInstance;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;

  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

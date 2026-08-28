import * as THREE from 'three';

/**
 * The mode system: Geometry Painter is a collection of painting modes (crystals today;
 * coral, circuitry, feathers, ... tomorrow). Every mode consumes the same surface strokes
 * and returns a living StrokeInstance the app animates and manages uniformly, so adding a
 * mode never touches the painting/orbit/undo plumbing.
 */

export interface SurfaceSample {
  /** World-space hit — used only for the live stroke preview beads. */
  position: THREE.Vector3;
  normal: THREE.Vector3;
  /**
   * Anchor-space hit, captured at pick time. The canvas sphere floats (bobs and slowly
   * turns), so converting per-sample while painting keeps the stroke pinned to the surface
   * instead of smearing. Painted geometry is parented under the same anchor and rides along.
   */
  local: THREE.Vector3;
  localNormal: THREE.Vector3;
}

/** One painted stroke, alive in the scene: it grows in, animates, and can be disposed. */
export interface StrokeInstance {
  group: THREE.Group;
  /** Advance growth / idle animation. `time` is seconds since app start. */
  update(dt: number, time: number): void;
  /** Snap to fully grown (used when settings change and strokes rebuild in place). */
  finishGrowth(): void;
  /**
   * Re-derive the stroke's look from new settings IN PLACE (no dispose/recreate) —
   * matrices and colors update on the existing instanced meshes. Modes that can't
   * do this omit it and the app falls back to a rebuild.
   */
  applySettings?(settings: unknown): void;
  dispose(): void;
}

export interface PaintMode<S = unknown> {
  readonly id: string;
  /** Build the living geometry for one stroke. Samples are in anchor-local space. */
  createStroke(samples: SurfaceSample[], seed: number, settings: S): StrokeInstance;
}

/** Deterministic per-stroke RNG (mulberry32) shared by all modes. */
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

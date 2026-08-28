import {SurfaceSample} from "./modes/mode";

export type ModeName =
  | "Crystals"
  | "Molten fissures"
  | "Aurora silk"
  | "Bioluminescent reff";

const GROUND_Y = -1.55;

interface Stroke {
  samples: SurfaceSample[];
  index: number;
  mode: ModeName;
}

export interface AppSettings {
  mode: ModeName;
  drawMode: boolean;
  seed: number;
  exposure: number;
  envIntensity: number;
  backlight: number;
  bloomStrength: number;
  bloomThreshold: number;
}

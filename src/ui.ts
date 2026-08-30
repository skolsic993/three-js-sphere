import GUI from "lil-gui";
import type { App } from "./app";
import { MAX_GROWTH_SPEED } from "./modes/crystals";

export function buildGui(app: App): GUI {
  const gui = new GUI();
  const s = app.settings;
  const c = app.crystal;

  // Crystal edits update existing strokes IN PLACE (no regeneration).
  const liveCrystal = () => app.updateCrystalSettings();

  const fDraw = gui.addFolder("Drawing");
  fDraw
    .add(s, "drawMode")
    .name("Paint mode (D)")
    .listen()
    .onChange(() => app.applyModes());
  fDraw.add({ undo: () => app.undoLast() }, "undo").name("Undo last stroke");
  fDraw.add({ clear: () => app.clearAll() }, "clear").name("Clear all");

  const fCrystal = gui.addFolder("Crystals (live)");
  // Coverage rebuilds the random fill (not a live matrix tweak).
  fCrystal
    .add(c, "surfaceCoverage", 0, 1, 0.01)
    .name("Surface coverage")
    .onChange(() => app.rebuildMainRockCoverage(false));
  fCrystal
    .add(c, "clusterDensity", 1, 16)
    .name("Clusters / unit")
    .onChange(liveCrystal);
  fCrystal
    .add(c, "crystalSize", 0.03, 0.4)
    .name("Crystal size")
    .onChange(liveCrystal);
  fCrystal
    .add(c, "shards", 0, 16, 1)
    .name("Shards / cluster")
    .onChange(liveCrystal);
  fCrystal
    .add(c, "spread", 0.3, 2.5)
    .name("Cluster spread")
    .onChange(liveCrystal);
  fCrystal.add(c, "tilt", 0, 1).name("Lean / wildness").onChange(liveCrystal);
  fCrystal
    .add(c, "sizeJitter", 0, 1)
    .name("Size variety")
    .onChange(liveCrystal);
  // Glow retints shared materials in place — instant, no regrow.
  fCrystal
    .add(c, "glow", 0, 2)
    .name("Inner glow")
    .onChange((v: number) => app.setGlow(v));
  fCrystal
    .add(c, "growthSpeed", 0.2, MAX_GROWTH_SPEED)
    .name("Growth speed")
    .onChange(liveCrystal);

  const fLook = gui.addFolder("Light & look (live)");
  fLook
    .add(s, "exposure", 0.4, 2.2)
    .name("Exposure")
    .onChange((v: number) => app.setExposure(v));
  fLook
    .add(s, "envIntensity", 0, 2.5)
    .name("Studio light")
    .onChange((v: number) => app.setEnvIntensity(v));
  fLook
    .add(s, "backlight", 0, 2.5)
    .name("Backlight")
    .onChange((v: number) => app.setBacklight(v));
  fLook
    .add(s, "bloomStrength", 0, 1.5)
    .name("Bloom")
    .onChange((v: number) => app.setBloomStrength(v));
  fLook
    .add(s, "bloomThreshold", 0.2, 1.5)
    .name("Bloom threshold")
    .onChange((v: number) => app.setBloomThreshold(v));
  // Reseeding regenerates painted strokes + the random surface fill.
  fLook
    .add(s, "seed", 0, 999, 1)
    .name("Seed")
    .onChange(() => app.reseedAll("instant"));

  const fGrowth = gui.addFolder("Growth animation");
  fGrowth
    .add({ replay: () => app.reseedAll("animate") }, "replay")
    .name("▶ Replay growth");

  return gui;
}

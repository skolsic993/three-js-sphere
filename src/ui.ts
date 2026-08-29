import GUI from 'lil-gui';
import type { App, ModeName } from './app';
import type { CrystalPaletteName } from './modes/crystals';
import type { AuroraPaletteName } from './modes/aurora';
import type { ReefPaletteName } from './modes/reef';

export function buildGui(app: App): GUI {
  const gui = new GUI({ title: 'Geometry Painter' });
  const s = app.settings;
  const c = app.crystal;
  const f = app.fissure;
  const a = app.aurora;
  const r = app.reef;

  // Mode edits update existing strokes IN PLACE (no regeneration) — matrices, colors and
  // shader uniforms recompose on the live objects as you drag.
  const liveCrystal = () => app.updateModeSettings('Crystals');
  const liveFissure = () => app.updateModeSettings('Molten fissures');
  const liveAurora = () => app.updateModeSettings('Aurora silk');
  const liveReef = () => app.updateModeSettings('Bioluminescent reef');

  const crystalFolders: GUI[] = [];
  const fissureFolders: GUI[] = [];
  const auroraFolders: GUI[] = [];
  const reefFolders: GUI[] = [];

  gui
    .add(s, 'mode', ['Crystals', 'Molten fissures', 'Aurora silk', 'Bioluminescent reef'] satisfies ModeName[])
    .name('Painting mode')
    .onChange((m: ModeName) => {
      syncFolders(m);
      app.applyModes(); // refresh the HUD wording
    });

  const fDraw = gui.addFolder('Drawing');
  fDraw.add(s, 'drawMode').name('Paint mode (D)').listen().onChange(() => app.applyModes());
  fDraw.add({ undo: () => app.undoLast() }, 'undo').name('Undo last stroke');
  fDraw.add({ clear: () => app.clearAll() }, 'clear').name('Clear all');

  // ---------- crystals ----------

  const fCrystal = gui.addFolder('Crystals (live)');
  const palettes: CrystalPaletteName[] = ['Amethyst', 'Ice', 'Emerald', 'Citrine', 'Rose', 'Prism'];
  fCrystal.add(c, 'palette', palettes).name('Palette').onChange(liveCrystal);
  fCrystal.add(c, 'clusterDensity', 1, 16).name('Clusters / unit').onChange(liveCrystal);
  fCrystal.add(c, 'crystalSize', 0.06, 0.4).name('Crystal size').onChange(liveCrystal);
  fCrystal.add(c, 'shards', 0, 16, 1).name('Shards / cluster').onChange(liveCrystal);
  fCrystal.add(c, 'spread', 0.3, 2.5).name('Cluster spread').onChange(liveCrystal);
  fCrystal.add(c, 'tilt', 0, 1).name('Lean / wildness').onChange(liveCrystal);
  fCrystal.add(c, 'sizeJitter', 0, 1).name('Size variety').onChange(liveCrystal);
  fCrystal.add(c, 'clearMix', 0, 1).name('Clear crystal mix').onChange(liveCrystal);
  // Glow retints shared materials in place — instant, no regrow.
  fCrystal.add(c, 'glow', 0, 2).name('Inner glow').onChange((v: number) => app.setGlow(v));
  fCrystal.add(c, 'growthSpeed', 0.2, 4).name('Growth speed').onChange(liveCrystal);
  crystalFolders.push(fCrystal);

  // ---------- molten fissures ----------

  const fFissure = gui.addFolder('Molten fissures (live)');
  fFissure.add(f, 'width', 0.02, 0.16).name('Crack width').onChange(liveFissure);
  fFissure.add(f, 'heat', 0.2, 3).name('Heat').onChange(liveFissure);
  fFissure.add(f, 'pulseSpeed', 0, 3).name('Pulse speed').onChange(liveFissure);
  fFissure.add(f, 'branchDensity', 0, 8).name('Branches / unit').onChange(liveFissure);
  fFissure.add(f, 'branchLength', 0.05, 0.6).name('Branch length').onChange(liveFissure);
  fFissure.add(f, 'emberRate', 0, 80).name('Embers').onChange(liveFissure);
  fFissure.add(f, 'rockDensity', 0, 30).name('Rock lips / unit').onChange(liveFissure);
  fFissure.add(f, 'rockSize', 0.03, 0.2).name('Rock size').onChange(liveFissure);
  fFissure.add(f, 'lightSpill', 0, 3).name('Light spill').onChange(liveFissure);
  fFissure.add(f, 'growthSpeed', 0.5, 6).name('Crack speed').onChange(liveFissure);
  fissureFolders.push(fFissure);

  // ---------- aurora silk ----------

  const fAurora = gui.addFolder('Aurora silk (live)');
  const auroraPalettes: AuroraPaletteName[] = ['Borealis', 'Twilight', 'Ember', 'Spectrum'];
  fAurora.add(a, 'palette', auroraPalettes).name('Palette').onChange(liveAurora);
  fAurora.add(a, 'height', 0.15, 1.3).name('Curtain height').onChange(liveAurora);
  fAurora.add(a, 'wave', 0, 1).name('Billow').onChange(liveAurora);
  fAurora.add(a, 'flow', 0, 3).name('Flow speed').onChange(liveAurora);
  fAurora.add(a, 'rays', 0, 1).name('Ray streaks').onChange(liveAurora);
  fAurora.add(a, 'brightness', 0.2, 2.5).name('Brightness').onChange(liveAurora);
  fAurora.add(a, 'sparkles', 0, 240, 1).name('Star motes').onChange(liveAurora);
  fAurora.add(a, 'lightSpill', 0, 3).name('Light spill').onChange(liveAurora);
  fAurora.add(a, 'growthSpeed', 0.3, 4).name('Unfurl speed').onChange(liveAurora);
  auroraFolders.push(fAurora);

  // ---------- bioluminescent reef ----------

  const fReef = gui.addFolder('Bioluminescent reef (live)');
  const reefPalettes: ReefPaletteName[] = ['Abyss', 'Tropic', 'Ghost', 'Toxic'];
  fReef.add(r, 'palette', reefPalettes).name('Palette').onChange(liveReef);
  fReef.add(r, 'colonySize', 0.08, 0.35).name('Colony size').onChange(liveReef);
  fReef.add(r, 'density', 2, 14).name('Colonies / unit').onChange(liveReef);
  fReef.add(r, 'branching', 0, 1).name('Branching').onChange(liveReef);
  fReef.add(r, 'tendrils', 0, 14, 1).name('Anemone arms').onChange(liveReef);
  fReef.add(r, 'glow', 0, 2.5).name('Bioluminescence').onChange(liveReef);
  fReef.add(r, 'pulseSpeed', 0, 3).name('Pulse speed').onChange(liveReef);
  fReef.add(r, 'sway', 0, 1).name('Current sway').onChange(liveReef);
  fReef.add(r, 'plankton', 0, 220, 1).name('Plankton').onChange(liveReef);
  fReef.add(r, 'lightSpill', 0, 3).name('Light spill').onChange(liveReef);
  fReef.add(r, 'growthSpeed', 0.3, 4).name('Bloom speed').onChange(liveReef);
  reefFolders.push(fReef);

  // ---------- shared ----------

  const fLook = gui.addFolder('Light & look (live)');
  fLook.add(s, 'exposure', 0.4, 2.2).name('Exposure').onChange((v: number) => app.setExposure(v));
  fLook.add(s, 'envIntensity', 0, 2.5).name('Studio light').onChange((v: number) => app.setEnvIntensity(v));
  fLook.add(s, 'backlight', 0, 2.5).name('Backlight').onChange((v: number) => app.setBacklight(v));
  fLook.add(s, 'bloomStrength', 0, 1.5).name('Bloom').onChange((v: number) => app.setBloomStrength(v));
  fLook.add(s, 'bloomThreshold', 0.2, 1.5).name('Bloom threshold').onChange((v: number) => app.setBloomThreshold(v));
  // Reseeding genuinely regenerates (new randoms), so it goes through the rebuild path.
  fLook.add(s, 'seed', 0, 999, 1).name('Seed').onChange(() => app.scheduleRegrow('instant'));

  const fGrowth = gui.addFolder('Growth animation');
  fGrowth.add({ replay: () => app.scheduleRegrow('animate') }, 'replay').name('▶ Replay growth');

  function syncFolders(m: ModeName): void {
    for (const g of crystalFolders) (m === 'Crystals' ? g.show() : g.hide());
    for (const g of fissureFolders) (m === 'Molten fissures' ? g.show() : g.hide());
    for (const g of auroraFolders) (m === 'Aurora silk' ? g.show() : g.hide());
    for (const g of reefFolders) (m === 'Bioluminescent reef' ? g.show() : g.hide());
  }
  syncFolders(s.mode);

  return gui;
}

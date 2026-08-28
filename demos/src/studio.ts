import * as THREE from 'three/webgpu';
import { crystalMode, defaultCrystalSettings } from '../../src/modes/crystals';
import { ENV_PANELS, Panel, Readouts, arcSamples, buildEnvironmentScene, canvasSphere, createStage, fatal, studioLights, type EnvPanel } from './kit';

/**
 * Demo — "the environment is the lighting".
 *
 * There are no lights in this scene by default. Everything you can see on the crystals is a
 * reflection of six emissive quads floating around the subject, prefiltered into an
 * environment map. Switch a quad off and its highlight goes with it.
 *
 * Turn on "Show the panels" to see the room the reflections are coming from.
 */

const RADIUS = 1;

const stage = await createStage({
  cameraPos: [0.4, 0.9, 3.2],
  fov: 42,
  environment: true,
  bloom: { strength: 0.35, threshold: 0.85 },
  orbit: true,
}).catch((err) => {
  fatal(err);
  return null;
});

if (stage) {
  const { scene } = stage;
  scene.add(canvasSphere(RADIUS, 96));

  const samples = arcSamples({
    radius: RADIUS,
    from: new THREE.Vector3(-0.55, -0.1, 0.95),
    to: new THREE.Vector3(0.75, 0.65, 0.7),
    count: 60,
    wobble: 0.07,
  });
  const stroke = crystalMode.createStroke(
    samples,
    0xa11ce,
    { ...defaultCrystalSettings, crystalSize: 0.2, clusterDensity: 8, shards: 8 },
  );
  stroke.finishGrowth();
  scene.add(stroke.group);

  // The same quads that get prefiltered, added to the real scene at their real positions.
  const panelRoom = buildEnvironmentScene(ENV_PANELS);
  const panelMeshes = new Map<string, THREE.Object3D>();
  for (const child of [...panelRoom.children]) {
    scene.add(child);
    panelMeshes.set(child.userData.panelId as string, child);
    child.visible = false;
  }

  // An optional three-point rig, off by default — the point is what the env map alone does.
  const rig = new THREE.Group();
  studioLights(rig);
  rig.visible = false;
  scene.add(rig);

  // ---------- state ----------

  const enabled = new Set(ENV_PANELS.map((p) => p.id));
  let showPanels = false;
  let rebuilds = 0;

  const out = new Readouts();
  const readPanels = out.add('Panels lit', `${enabled.size} / ${ENV_PANELS.length}`, 'hi');
  const readLights = out.add('Actual lights', '0', 'good');
  const readRebuild = out.add('PMREM bakes', '1');

  function refresh(): void {
    const active: EnvPanel[] = ENV_PANELS.filter((p) => enabled.has(p.id));
    stage!.setEnvironment(active);
    rebuilds++;
    readPanels(`${enabled.size} / ${ENV_PANELS.length}`);
    readRebuild(String(rebuilds));
    for (const p of ENV_PANELS) {
      const mesh = panelMeshes.get(p.id);
      if (mesh) mesh.visible = showPanels && enabled.has(p.id);
    }
  }

  const ui = new Panel('Light panels');
  for (const p of ENV_PANELS) {
    ui.check({
      label: p.label,
      value: true,
      onChange: (v) => {
        if (v) enabled.add(p.id);
        else enabled.delete(p.id);
        refresh();
      },
    });
  }
  ui.check({
    label: 'Show the panels',
    onChange: (v) => { showPanels = v; refresh(); },
  });
  ui.check({
    label: 'Add a three-point rig',
    onChange: (v) => {
      rig.visible = v;
      readLights(v ? '4' : '0', v ? 'plain' : 'good');
    },
  });
  ui.note(
    'Every glint on those facets is one of these quads. The hard top-back strip at ' +
    '<b>intensity 22</b> is doing most of the work.',
  );

  refresh();
  rebuilds = 1;
  readRebuild('1');

  stage.onFrame((dt, t) => stroke.update(dt, t));
}

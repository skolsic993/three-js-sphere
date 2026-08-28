import * as THREE from 'three/webgpu';
import { BVHHelper } from 'three-mesh-bvh';
import { firstHitOnly, indexForRaycasts } from '../../src/bvh';
import { Panel, Readouts, canvasSphere, createStage, debugArrow, fatal, orientY, studioLights } from './kit';

/**
 * Demo — "one pointer event becomes a surface sample".
 *
 * Everything the painter hands to a mode comes out of this single raycast: the hit point,
 * the interpolated face normal, and the tangent frame we build from it. The demo draws that
 * frame live, and lets you switch the BVH off to watch the pick cost jump.
 */

const stage = await createStage({
  cameraPos: [0.2, 0.9, 3.6],
  environment: true,
  orbit: true,
}).catch((err) => {
  fatal(err);
  return null;
});

if (stage) {
  const { scene, camera, renderer } = stage;
  studioLights(scene);

  // Deliberately dense: ~34k triangles, so "walk the BVH" vs "test every triangle" is a
  // difference you can read off the panel instead of taking on faith.
  const sphere = canvasSphere(1, 160);
  scene.add(sphere);
  indexForRaycasts(sphere);
  const boundsTree = (sphere.geometry as unknown as { boundsTree: unknown }).boundsTree;
  const triangles = (sphere.geometry.getIndex()?.count ?? sphere.geometry.getAttribute('position').count) / 3;

  const bvhHelper = new BVHHelper(sphere, 10);
  bvhHelper.visible = false;
  scene.add(bvhHelper);

  // ---------- the frame gizmo ----------

  const gizmo = new THREE.Group();
  gizmo.visible = false;
  scene.add(gizmo);

  const normalArrow = debugArrow(0xc9a4ff, 0.55); // n  — the surface normal
  const t1Arrow = debugArrow(0x5ad6ff, 0.4);      // t1 — first tangent
  const t2Arrow = debugArrow(0xffc46a, 0.4);      // t2 — n × t1
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.16, 0.185, 48),
    new THREE.MeshBasicMaterial({ color: 0xc9a4ff, side: THREE.DoubleSide, depthTest: false, toneMapped: false }),
  );
  ring.renderOrder = 20;
  const plane = new THREE.Mesh(
    new THREE.CircleGeometry(0.17, 48),
    new THREE.MeshBasicMaterial({
      color: 0x8a5cff, side: THREE.DoubleSide, transparent: true, opacity: 0.18,
      depthTest: false, toneMapped: false,
    }),
  );
  plane.renderOrder = 19;
  gizmo.add(normalArrow, t1Arrow, t2Arrow, ring, plane);

  // ---------- picking ----------

  const raycaster = firstHitOnly(new THREE.Raycaster());
  const pointer = new THREE.Vector2();
  const t1 = new THREE.Vector3();
  const t2 = new THREE.Vector3();

  let autoTour = true;
  let useBvh = true;
  let costEma = 0;

  renderer.domElement.addEventListener('pointermove', (e) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    if (autoTour) setAuto(false);
  });

  function pick(): THREE.Intersection | null {
    raycaster.setFromCamera(pointer, camera);
    // One raycast is ~microseconds; average ten so the readout doesn't flicker.
    const t0 = performance.now();
    let hits: THREE.Intersection[] = [];
    for (let i = 0; i < 10; i++) hits = raycaster.intersectObject(sphere, false);
    costEma = costEma * 0.9 + ((performance.now() - t0) / 10) * 0.1;
    return hits.find((h) => h.face) ?? null;
  }

  // ---------- panel ----------

  const ui = new Panel('Picking');
  const setAuto = ui.check({
    label: 'Auto tour',
    value: true,
    onChange: (v) => { autoTour = v; },
  });
  ui.check({
    label: 'Use the BVH',
    value: true,
    onChange: (v) => {
      useBvh = v;
      // three-mesh-bvh's patched raycast falls back to the stock one when no tree is present.
      (sphere.geometry as unknown as { boundsTree: unknown }).boundsTree = v ? boundsTree : null;
      if (!v) bvhHelper.visible = false;
      readBvh(v ? 'walking the tree' : 'brute force', v ? 'good' : 'bad');
    },
  });
  ui.check({
    label: 'Show BVH boxes',
    onChange: (v) => { bvhHelper.visible = v && useBvh; },
  });
  ui.slider({
    label: 'BVH depth',
    value: 10,
    min: 1,
    max: 20,
    step: 1,
    format: (v) => String(v),
    onChange: (v) => {
      bvhHelper.depth = v;
      bvhHelper.update();
    },
  });
  ui.note(
    'The frame is <b>n</b> (violet), <b>t1</b> (blue) and <b>t2</b> = n × t1 (amber). ' +
    'Every mode plants its geometry in that frame.',
  );

  const out = new Readouts();
  const readTris = out.add('Sphere triangles', triangles.toLocaleString());
  const readBvh = out.add('Raycast strategy', 'walking the tree', 'good');
  const readCost = out.add('Cost per pick', '—', 'hi');
  const readHit = out.add('Hit point', '—');
  const readNormal = out.add('Normal', '—');
  readTris(triangles.toLocaleString());

  // ---------- frame ----------

  let frame = 0;
  stage.onFrame((_dt, time) => {
    if (autoTour) {
      // Keep the synthetic pointer inside the sphere's silhouette whatever the aspect is.
      const dist = camera.position.length();
      const maxY = (1 / dist) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.62;
      pointer.set(
        (maxY / camera.aspect) * Math.sin(time * 0.63),
        maxY * Math.sin(time * 0.41 + 1.1),
      );
    }

    const hit = pick();
    if (!hit?.face) {
      gizmo.visible = false;
      return;
    }
    gizmo.visible = true;

    const n = hit.face.normal.clone().transformDirection(sphere.matrixWorld);
    // The same two lines every mode runs: pick any axis that isn't parallel to n, then
    // cross twice to get an orthonormal basis lying in the tangent plane.
    t1.set(1, 0, 0);
    if (Math.abs(n.x) > 0.9) t1.set(0, 1, 0);
    t1.cross(n).normalize();
    t2.crossVectors(n, t1);

    gizmo.position.copy(hit.point);
    orientY(normalArrow, n);
    orientY(t1Arrow, t1);
    orientY(t2Arrow, t2);
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    plane.quaternion.copy(ring.quaternion);
    ring.position.copy(n).multiplyScalar(0.002);
    plane.position.copy(ring.position);

    if (++frame % 3 === 0) {
      const v = (a: THREE.Vector3): string => `${a.x.toFixed(2)}, ${a.y.toFixed(2)}, ${a.z.toFixed(2)}`;
      readCost(`${(costEma * 1000).toFixed(1)} µs`);
      readHit(v(hit.point));
      readNormal(v(n));
    }
  });
}

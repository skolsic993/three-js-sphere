import * as THREE from "three";

export interface BackLightEntry {
  light: THREE.DirectionalLight;
  base: number;
}

/**
 * Daylight reflections for metal gold: a bright sun disk, open blue sky, and a warm
 * ground bounce — so scratched-gold facets pick up outdoor speculars instead of studio strips.
 */
export function setupEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  envIntensity: number,
): void {
  const env = new THREE.Scene();
  const geo = new THREE.PlaneGeometry(1, 1);

  const panel = (
    color: number,
    intensity: number,
    w: number,
    h: number,
    pos: [number, number, number],
  ): void => {
    const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    mat.color.set(color).multiplyScalar(intensity);
    const m = new THREE.Mesh(geo, mat);
    m.scale.set(w, h, 1);
    m.position.set(...pos);
    m.lookAt(0, 0, 0);
    env.add(m);
  };

  panel(0xfff4d6, 55, 1.2, 1.2, [4, 9, 3]);
  panel(0xffe8b8, 18, 3.5, 2.5, [2, 8, 1]);
  panel(0xa8c8f0, 4, 14, 8, [0, 6, -4]);
  panel(0xd8e8ff, 2.5, 10, 5, [-5, 4, 2]);
  panel(0xffe2b0, 3, 8, 4, [5, 2, 4]);
  panel(0xc4a882, 1.8, 12, 12, [0, -6, 0]);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(env, 0.04).texture;
  scene.environmentIntensity = envIntensity;
  pmrem.dispose();
  geo.dispose();
}

/**
 * Outdoor sun key + soft sky fill — warm daylight on the charcoal rock.
 * No shadow maps; canvas stays fully transparent for compositing.
 */
export function setupLights(scene: THREE.Scene): BackLightEntry[] {
  const hemi = new THREE.HemisphereLight(0xb8d4f5, 0x3a2e22, 0.05);

  const key = new THREE.SpotLight(0xfff2d8, 70, 0, Math.PI / 3.8, 0.45, 1.4);
  key.position.set(4.2, 7.2, 3.2);
  key.target.position.set(0, 0, 0);

  const fill = new THREE.DirectionalLight(0xc5d8f0, 0.14);
  fill.position.set(-3.5, 4.5, 2.5);

  const back = new THREE.DirectionalLight(0xd0e4ff, 0.12);
  back.position.set(-2.5, 4, -5);

  const goldKick = new THREE.DirectionalLight(0xffe2a8, 4.2);
  goldKick.position.set(3, 8, 2);

  scene.add(hemi, key, key.target, fill, back, goldKick);

  return [{ light: back, base: 0.12 }];
}

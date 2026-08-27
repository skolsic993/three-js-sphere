import * as THREE from "three";
import {CSS2DRenderer} from "three/examples/jsm/Addons.js";

//Scene
const scene = new THREE.Scene();

//Camera
const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  1,
  1000,
);

//Renderer
const renderer = new THREE.WebGLRenderer();
renderer.setSize(window.innerWidth, window.innerHeight);

document.body.appendChild(renderer.domElement);

//Elements
const geometry = new THREE.BoxGeometry(1, 1, 1);
const material = new THREE.MeshBasicMaterial({color: 0x00ff00});
const cube = new THREE.Mesh(geometry, material);
scene.add(cube);
camera.position.z = 5;

const text = new THREE.( text, parameters );
scene.add(text);

function animate(time) {
  cube.rotation.x = time / 2000;
  cube.rotation.y = time / 3000;

  renderer.render(scene, camera);
}
renderer.setAnimationLoop(animate);

import "./style.css";
import {createRockScene} from "./rock-scene.js";

const handle = createRockScene(document.querySelector("#app"));
window.rock = handle;

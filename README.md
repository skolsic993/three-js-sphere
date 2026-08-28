# 💎 Geometry Painter — three.js WebGPU

Paint geometry directly onto a hyper-real floating sphere. Drag a stroke across the
surface and watch it come alive — the first painting mode grows **crystal veins**:
clusters of refractive quartz points that pop out of the surface along your stroke.

Built on the same surface-painting foundation as
[VegetationGeneratorThreeJS](../VegetationGeneratorThreeJS), redesigned around an
extensible **mode system** — every painting mode consumes the same strokes and returns a
living instance the app grows, animates, undoes and rebuilds uniformly. More modes
(coral, circuitry, feathers, …) plug in without touching the painting plumbing.

## Modes

- **Crystals** — transmissive, iridescent quartz clusters with colored absorption and
  dispersion, six palettes (Amethyst, Ice, Emerald, Citrine, Rose, Prism), a live
  clear-quartz mix, elastic growth animation.
- **Molten fissures** — strokes tear glowing cracks into the surface: a TSL-shaded
  blackbody core with traveling heat pulses and a white-hot propagation front,
  lightning-like side branches (live density/length controls), basalt rock lips, rising
  embers, and flickering orange light spill. Crossing fissures blend additively into
  hotter junctions.
- **Aurora silk** — strokes unfurl waving curtains of light: two silk layers displaced by
  layered sine waves in the vertex stage, fold-locked brightness (the cloth glows along
  its moving folds), drifting ray striations, a glowing hem, twinkling star motes, and
  four palettes including a cosine-cycling Spectrum.
- **Bioluminescent reef** — strokes seed living deep-sea colonies: recursively branched
  staghorn corals studded with glowing polyps, swaying anemones, gorgonian fan lattices,
  drifting plankton — all pulsing on one traveling light wave that ripples through the
  whole reef like a signal through a single organism.
- _more coming…_

## The look

- **WebGPU renderer** (WebGL2 fallback), ACES filmic tone mapping, MSAA post pipeline.
- **Custom studio environment**: a black room with an HDR overhead softbox, cool/warm
  side strips and a violet back wash, prefiltered into the environment map — every
  highlight on the lacquered sphere and the crystals is one of these shapes.
- **Soft-shadow key light**, cool rim, violet underglow lifting the sphere off the floor.
- **Bloom** on the crystals' inner glow, drifting dust motes, slow floating bob.

## Controls

| Input | Action |
| --- | --- |
| **Drag** (paint mode) | Paint a crystal vein on the sphere |
| **D** / mode pill | Toggle paint ↔ orbit |
| Drag / scroll (orbit) | Rotate / zoom |
| GUI | Palette, density, size, lean, glow, lighting, bloom, seed, replay growth |

## Run

```bash
npm install
npm run dev
```

Requires a browser with WebGPU (recent Chrome/Edge) — falls back to WebGL2.

## Demos — how it works, one piece at a time

Ten standalone pages under [`/demos`](demos/), each isolating a single mechanism and looping it so
it can be watched (or screen-recorded) on its own. Most drive the production code directly.
Start the dev server and open **`/demos/`**.

| | Page | Shows |
| --- | --- | --- |
| 01 | [`picking`](demos/picking.html) | Raycast → hit, normal, tangent frame. BVH on/off with the pick cost. |
| 02 | [`anchor-space`](demos/anchor-space.html) | World space vs. anchor space on a canvas that keeps turning. |
| 03 | [`resample`](demos/resample.html) | Raw pointer samples vs. the evenly stepped centreline. |
| 04 | [`cull`](demos/cull.html) | Real crystal mode, real sliders, zero rebuilds. Culled instances shown as ghosts. |
| 05 | [`growth`](demos/growth.html) | Birth distance, growth window, linear vs. `easeOutBack`. |
| 06 | [`ribbon`](demos/ribbon.html) | The fissure strip with every vertex on the centreline; width lives in the shader. |
| 07 | [`blackbody`](demos/blackbody.html) | The heat ramp, one term at a time. |
| 08 | [`fold-light`](demos/fold-light.html) | Sharing the wave phase between vertex and fragment stages. |
| 09 | [`colony-pulse`](demos/colony-pulse.html) | A world-space pulse vs. per-object phase. |
| 10 | [`studio`](demos/studio.html) | The six env panels and the highlights each one makes. |

Add `?still=4` to any demo URL to simulate four seconds, draw one frame and stop — useful for
stills, and it lets a headless browser capture the page (an endless `rAF` loop never goes idle).

A long-form write-up of all of this lives in [ARTICLE.md](ARTICLE.md).

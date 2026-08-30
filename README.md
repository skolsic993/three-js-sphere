# Golden Rock — three.js WebGPU

Paint citrine crystal veins onto a hyper-real floating rock. Drag a stroke across the
surface and watch scratched metallic gold nuggets pop out along your path.

## The look

- **WebGPU renderer** (WebGL2 fallback), ACES filmic tone mapping, MSAA post pipeline.
- **Daylight environment**: sun disk, open sky, and warm ground bounce prefiltered into
  the environment map — every highlight on the charcoal rock and gold crystals is one of
  these shapes.
- **Soft-shadow key light**, cool rim, violet underglow lifting the rock off the floor.
- **Bloom** on the crystals' inner glow, slow mouse-driven tilt.

## Controls

| Input | Action |
| --- | --- |
| **Drag** (paint mode) | Paint a crystal vein on the rock |
| **D** | Toggle paint ↔ orbit |
| Drag / scroll (orbit) | Rotate / zoom |
| GUI | Density, size, lean, glow, lighting, bloom, seed, replay growth |

## Run

```bash
npm install
npm run dev
```

Requires a browser with WebGPU (recent Chrome/Edge) — falls back to WebGL2.

<!-- ────────────────────────────────────────────────────────────────────────────
     DELETE THIS BLOCK BEFORE SUBMITTING.

     It's written in your voice, first person, so a few personal details are
     reconstructions from the code and its comments rather than things I know.
     Please correct or cut anything that isn't true:

     · "The first version painted plants… after a week of living with it" —
       the VegetationGeneratorThreeJS origin story and its timeline.
     · "The reference image in my head was a geode" — the stated motivation
       for the dark-canvas/bright-crystal contrast.
     · "cost me an afternoon" (the anchor-space bug), "shipped for about an
       hour" (per-sample scatter), "about ten minutes" (line width) — the
       durations, not the bugs themselves. The bugs are all in the comments.
     · "The material took the longest of anything in this project."
     · The Credits list — check I haven't missed anyone.

     Also needs from you:
     · The Demo link (currently `#`).
     · A hero GIF, plus the ten GIFs marked 🎥 (each one names the demo route
       and what to do on it).
     · The author bio block at the end.
──────────────────────────────────────────────────────────────────────────── -->

# Building a Geometry Painter with Three.js and WebGPU

*Drag a stroke across a floating sphere and watch crystal veins, molten cracks, aurora silk or a
bioluminescent reef grow out of the surface — a look at instancing, TSL node materials, live
parameter systems, and the small architectural decision that lets a new painting mode plug in
without touching a single line of the painting code.*

**Tags:** 3D · WebGPU · Three.js · TSL · procedural

[**Demo**](#) · [**GitHub**](https://github.com/mohamedachrefelouafi/GeometryPainterThreeJS)

---

I have a bad habit with generative work. I build the generator, I get one good-looking result,
and then I spend three weeks making a slider for every number in the file. This project started
as a reaction to that: instead of another parameter panel that spits out a scene, I wanted
something where the *input* was a gesture. You drag. Something grows where you dragged.

The first version painted plants. It was called VegetationGeneratorThreeJS and it did exactly one
thing — trees along a stroke — and after a week of living with it I realised the interesting part
wasn't the trees at all. It was the seam between "here is a path across a surface" and "here is
what grows on it". Everything on the left of that seam is the same forever: raycasting, resampling,
undo, orbit. Everything on the right is a different art project every time.

So I threw the plants out and rebuilt the thing around that seam. Four modes ship today — crystals,
molten fissures, aurora silk, and a bioluminescent reef — and each one was written without opening
the painting code once.

![Hero shot of the four painting modes](gifs/hero.gif)

Here's what I want to cover:

- **Turning a drag into geometry** — picking with a BVH, why raw pointer events are useless as a
  path, and the coordinate-space bug that eats an afternoon if you don't see it coming.
- **The mode contract** — the twenty lines that make a painting mode pluggable.
- **Making every slider live** — how to build a system where dragging a density slider never
  regenerates anything, and why that constraint made the modes *better*, not just faster.
- **Four shaders** — transmissive quartz, a blackbody crack ribbon, fold-locked aurora silk, and a
  bioluminescence wave that lives in world space.
- **The look** — a studio built out of six glowing rectangles, and the post chain on top of it.

Everything below has a demo page you can open, poke and watch on its own. They live under
`/demos` in the repo — `npm run dev` and go to `/demos/` — they run the production code wherever
that was possible, and I'll link the relevant one as we go. Honestly, they were built for this
article and then I kept using them for debugging, which tells you something about how I should
have been working all along.

---

## The concept

The reference image in my head was a geode: a dull grey rock that somebody cut open, and inside,
this violent violet interior that has no business being there. That contrast is the whole idea.
The canvas sphere is deliberately boring — satin basalt, roughness 0.52, a whisper of clearcoat —
because the crystals have to be the only interesting thing in frame.

That decision drove more of the codebase than I expected. If the canvas is matte and dark, then
whatever you paint on it must supply its own light: transmission, emissive, additive ribbons,
point lights riding along the stroke. Every mode ended up with some version of "this thing glows
from the inside", not because I planned it, but because anything that didn't glow just vanished
into the sphere.

---

## The implementation

### One pointer event, one surface sample

Painting on a mesh is a raycast, which is the easy part. What each mode actually needs is a little
more than a hit point:

```ts
export interface SurfaceSample {
  /** World-space hit — used only for the live stroke preview beads. */
  position: THREE.Vector3;
  normal: THREE.Vector3;
  /** Anchor-space hit, captured at pick time. */
  local: THREE.Vector3;
  localNormal: THREE.Vector3;
}
```

From the normal we build a tangent frame, and that frame is where everything gets planted — a
crystal leans off `n` by rotating toward `t1`/`t2`, a fissure expands sideways along `t1 × n`, an
anemone tendril fans out around `n`. It's three lines and they're worth staring at once:

```ts
const t1 = new THREE.Vector3(1, 0, 0);
if (Math.abs(n.x) > 0.9) t1.set(0, 1, 0); // pick an axis that isn't parallel to n
t1.cross(n).normalize();
const t2 = new THREE.Vector3().crossVectors(n, t1);
```

The `Math.abs(n.x) > 0.9` guard is the only interesting bit. Cross two parallel vectors and you get
a zero vector, and a zero vector normalised is `NaN`, and `NaN` in a matrix means an instance
silently disappears. You will find this bug on the poles of a sphere at 2am.

For picking itself I patch `three-mesh-bvh` in globally and build a bounds tree on the canvas:

```ts
(THREE.Mesh.prototype as any).raycast = acceleratedRaycast;
// ...
(raycaster as any).firstHitOnly = true;
```

The `firstHitOnly` flag matters more than the BVH does, in a way. Without it the raycaster collects
*every* intersection and sorts them, and painting on a closed sphere means you hit the back face
too. With it, the traversal bails the moment it has the nearest triangle. The demo page below
picks against a 33,600-triangle sphere and prints the cost of a single pick, with a checkbox to
drop the bounds tree and go back to testing every triangle.

> 🎥 **GIF 01** — record `/demos/picking.html`. Let the auto tour sweep for a few seconds, then
> untick **Use the BVH** and let the "cost per pick" readout settle at its new number. Tick
> **Show BVH boxes** for the last second or two.

![Surface picking and the tangent frame](gifs/01-picking.gif)

### Pointer events are not a path

Here's a thing nobody tells you. Pointer events arrive at a fixed *rate*, not a fixed *distance*.
Move your hand slowly and you get forty samples in a centimetre. Sweep it and you get four across
the whole sphere. If you scatter one crystal cluster per sample — which is the obvious first
implementation, and the one I shipped for about an hour — you get a dense clot wherever the user
hesitated and nothing at all where they moved.

So every mode resamples before it builds anything:

```ts
let travelled = 0;
let next = 0;
for (let i = 0; i < samples.length; i++) {
  if (i > 0) travelled += samples[i].local.distanceTo(samples[i - 1].local);
  if (travelled < next && i !== samples.length - 1) continue;
  next = travelled + PATH_STEP;
  // ... emit a path point with its tangent frame
}
```

That's it. Walk the raw samples accumulating arc length, emit a point every `PATH_STEP` world
units, throw the rest away. Crystals drop a cluster every 0.0625 units, the fissure ribbon steps
its centreline every 0.025. The `travelled` value it hands back does double duty later — it's the
distance coordinate the whole growth animation runs on.

The demo below draws a fairly typical stroke: 46 raw samples with gaps ranging from 0.002 to
0.089 world units. That's a factor of forty-four between the tightest and the loosest pair, on a
single stroke, and it's not even a deliberately erratic one.

> 🎥 **GIF 02** — record `/demos/resample.html`. Start with everything on so both dot sets are
> visible, then drag the **step** slider from 0.015 up to 0.14 and back. The white dots never
> move; the violet ones respace themselves.

![Raw pointer samples versus the resampled centreline](gifs/02-resample.gif)

### The canvas moves while you're painting

This is the one that cost me an afternoon.

The sphere floats. It bobs on a slow sine and turns, because a perfectly static subject looks like
a screenshot. Painting worked fine in the first build — until I let go of the mouse, watched the
crystals grow in, and then watched them slide off the surface like decals on a wet windscreen.

The samples were in world space. Of course they were; that's what the raycaster gives you. But
"world space" is only meaningful at the instant of the hit, and by the time the growth animation
finished the sphere had turned 15°. So each sample gets converted to the anchor's local space
*immediately*, at pick time:

```ts
this.anchor.updateWorldMatrix(true, false);
this.invAnchor.copy(this.anchor.matrixWorld).invert();
return {
  position: h.point.clone(),
  normal,
  local: h.point.clone().applyMatrix4(this.invAnchor),
  localNormal: normal.clone().transformDirection(this.invAnchor),
};
```

Note the inverse is recomputed on *every* pick, not cached per stroke. It has to be: the anchor is
moving between pointer events, so a stroke that takes two seconds to draw was sampled against a
hundred slightly different matrices. Cache it once at `pointerdown` and you get a subtler version
of the same smear — one that only shows up on slow, careful strokes, which is to say, on exactly
the strokes people care about.

> 🎥 **GIF 03** — record `/demos/anchor-space.html`. Let one full replay cycle run (the stroke
> draws, then both spheres keep turning for three seconds). Crank **canvas spin** to ~1.2 for a
> punchier loop. The drift readout climbing is the money shot.

![World space versus anchor space on a rotating canvas](gifs/03-anchor-space.gif)

### The mode contract

Now the seam. This is the whole extensibility story and it fits on one screen:

```ts
export interface StrokeInstance {
  group: THREE.Group;
  update(dt: number, time: number): void;
  finishGrowth(): void;
  applySettings?(settings: unknown): void;
  dispose(): void;
}

export interface PaintMode<S = unknown> {
  readonly id: string;
  createStroke(samples: SurfaceSample[], seed: number, settings: S): StrokeInstance;
}
```

A mode is a factory that turns samples into a living object. The app parents `group` under the
floating anchor, calls `update` every frame, calls `dispose` on undo, and otherwise doesn't know
or care what's inside. Registering one is a line in a record:

```ts
private modes: Record<ModeName, PaintMode<unknown>> = {
  'Crystals': crystalMode as PaintMode<unknown>,
  'Molten fissures': fissureMode as PaintMode<unknown>,
  'Aurora silk': auroraMode as PaintMode<unknown>,
  'Bioluminescent reef': reefMode as PaintMode<unknown>,
};
```

The optional `applySettings?` is the interesting piece of that interface, and I'll come back to it
in a second, but the short version: a mode that can re-derive its own look from new settings gets
live sliders for free, and a mode that can't falls back to a rebuild without anyone having to
write a special case.

The seed handling is worth a note too. Each stroke keeps a stable index, and the effective seed
mixes that with the global seed:

```ts
private effectiveSeed(index: number): number {
  return ((this.settings.seed * 2654435761) ^ (index * 40503 + 1)) >>> 0;
}
```

Knuth's multiplicative constant, an odd multiplier for the index, XOR. Nothing clever — but it
means every stroke looks different from its neighbours *and* the whole scene reshuffles coherently
when you drag the global seed, instead of every stroke jumping to the same new arrangement.

### Generate at the maximum, cull with the slider

Here's the constraint I set myself, and it turned out to be the most productive decision in the
project: **dragging a slider must never allocate anything.**

The naive version of a density slider disposes the stroke and rebuilds it. That's fine at
twenty instances. At two thousand, with `lil-gui` firing `onChange` sixty times a second, it's a
slideshow — and worse, every rebuild re-rolls the random numbers, so the geometry *shimmers* as
you drag. You can't judge a look you can't hold still.

So: generate everything at the slider maxima, once, and let the sliders decide what's visible.

```ts
export const MAX_DENSITY = 16;
export const MAX_SHARDS = 16;
```

Every crystal is stored as its *generative parameters*, never as a baked matrix — where its cluster
sits, its tangent frame, and a fistful of stable randoms in the 0–1 range:

```ts
interface CrystalInstance {
  anchor: THREE.Vector3;  // cluster's anchor-local surface point
  n: THREE.Vector3; t1: THREE.Vector3; t2: THREE.Vector3;
  clusterRnd: number;     // density culling rank
  shardIndex: number;     // shard-count culling rank
  offAz: number; offFrac: number; heightBase: number; jitterRnd: number;
  leanRnd: number; leanAz: number; spin: number;
  hueRnd: number; satRnd: number; clearRnd: number;
  // ...derived cache, rewritten by applySettings()
}
```

`applySettings` then recomposes every matrix and colour in place. Culling is a comparison against
a rank the instance has held since birth:

```ts
const densityFrac = s.clusterDensity / MAX_DENSITY;
inst.visible =
  inst.clusterRnd <= densityFrac &&
  (inst.kind !== 'shard' || inst.shardIndex < shardCap);
```

and a culled instance simply gets a zero-scale matrix. It stays in the buffer, it stays in the draw
call, it occupies exactly the same memory it did a frame ago, and it costs a vertex shader
invocation that produces a degenerate triangle. On any GPU made this decade that is free.

The `clusterRnd <= densityFrac` form matters. Because the rank is *stable*, raising the density
slider always reveals the same crystals in the same order — nothing reshuffles, existing clusters
never move. It reads as "more of this", not "a different thing". Same for the clear-quartz mix:
`inst.clearRnd < s.clearMix` converts the same crystals every time.

The clear/tinted split deserves its own note, because it's the same trick one level up. Every
crystal owns a slot in *two* InstancedMeshes — one bound to the palette material, one to the clear
refractive quartz — and only ever poses in one of them. The other holds a zero-scale matrix. So
"35% of these should be clear quartz" is a slider that switches materials per instance, which
instancing otherwise doesn't let you do at all.

Five shape variants × two material sets = ten `InstancedMesh` objects per stroke. A stroke about
two-thirds of the way across the sphere generates 537 crystals; at the default slider positions
119 of them are on screen and the other 418 are sitting in the buffers at zero scale, waiting.
Ten draw calls either way.

> 🎥 **GIF 04** — record `/demos/cull.html`. Tick **Show culled instances** first so the wireframe
> ghosts are visible, then drag **clusters / unit** and **shards / cluster** across their full
> range. Keep the readouts in frame — "geometry rebuilds: 0" while everything on screen changes is
> the entire point of the shot.

![Density culling with zero rebuilds](gifs/04-cull.gif)

### Growth is a distance, not a timer

Every mode grows in as the stroke "fills". None of them use a tween library, a timeline, or a
per-instance timer. There are two numbers:

- `birth` — the distance along the stroke at which an instance was seeded, decided once at
  generation time.
- `grown` — how far the growth front has travelled, advanced by `dt * growthSpeed` each frame.

And the animation is the difference:

```ts
const t = (this.grown - inst.birth) / GROW_WINDOW;
if (t <= 0) continue;                        // not born yet — matrix stays zero
const k = t >= 1 ? 1 : easeOutBack(t);
_s.set(inst.scale.x * k * (0.6 + 0.4 * k), inst.scale.y * k, inst.scale.z * k * (0.6 + 0.4 * k));
_m.compose(inst.pos, inst.quat, _s);
mesh.setMatrixAt(i, _m);
```

`GROW_WINDOW` is 0.45 world units, so at any moment the crystals inside a 0.45-unit band behind the
front are mid-pop and everything else is either invisible or finished. Growth speed is a live
slider because it only scales how fast `grown` moves. Replaying the animation is `grown = 0`.
Snapping to fully grown is `grown = total + window + 1`. There is no state to unwind.

Two details in that snippet do most of the visual work. The first is `easeOutBack`, which overshoots
by about 5% before settling — the difference between "a mesh appeared" and "a crystal snapped into
being". The second is the `(0.6 + 0.4 * k)` on the width but not the height: crystals emerge
narrow and then relax outward, which is how minerals actually grow and, more to the point, which
stops the pop from looking like a uniform scale-up.

The pose loop also freezes itself. Once every instance is past `t = 1` it sets a `done` flag and
`update()` returns immediately — a finished stroke costs nothing per frame, so you can cover the
sphere and the frame time doesn't move.

> 🎥 **GIF 05** — record `/demos/growth.html`. One full sweep at default speed, then drag the
> **growth window** slider wide (~1.2) and let it sweep again so the band of half-grown crystals is
> obvious. The little easing plot in the panel animates with it.

![The growth front sweeping two easings](gifs/05-growth.gif)

---

## Four modes

### Crystals: getting glass to read on a dark sphere

The quartz points are hexagonal prisms with a tapered shaft and an off-axis pyramidal termination,
built non-indexed so `computeVertexNormals()` gives genuinely flat facets. Facets are the entire
read — a smooth crystal is a blob.

Two small things in that geometry that I'd have skipped if I hadn't looked closely at photographs:
the facet columns are jittered *once* per column, so the prism edges stay straight from base to tip
instead of turning into noise; and the base cap closes to a point slightly *below* the base plane —

```ts
const bottom = new THREE.Vector3(0, -0.02, 0); // tiny below-base apex closes tilted crystals
```

— because a crystal that leans 30° off the normal otherwise shows you a flat, floating hexagon
where it meets the surface.

The material took the longest of anything in this project, and the two mistakes I made are both
worth stating out loud.

**Mistake one: full transmission.** `transmission: 1` on a crystal sitting on a near-black sphere
gives you a black crystal. Obvious in hindsight — transmission means you see what's behind it, and
what's behind it is a dark matte ball. The fix is to keep some diffuse:

```ts
mat = new THREE.MeshPhysicalMaterial({
  color: 0xffffff,
  roughness: 0.05,
  transmission: 0.7,     // NOT 1 — full transmission over a dark sphere reads as black glass
  ior: 1.55,
  thickness: 0.4,
  attenuationColor: p.attenuation,
  attenuationDistance: 0.5,
  dispersion: 0.3,       // chromatic fringing inside the glass — the "gem fire"
  iridescence: 0.4,
  clearcoat: 0.5,
  envMapIntensity: 1.6,
});
```

At 0.7 you still get the glass depth, but 30% of the surface shades facet-by-facet, which is what
gives a real amethyst cluster its milky translucence.

**Mistake two: tinting twice.** My first pass set `color` to the palette colour *and*
`attenuationColor` to a deeper version of it. The result was dark, muddy and weirdly opaque,
because the tint multiplies into itself — once on the way in as albedo, once on the way through as
absorption. The base colour is now white, always. The palette lives in the per-instance colours
and in the attenuation, and nowhere else.

Alongside the tinted material there's one shared clear-quartz material — `transmission: 1`,
`roughness: 0.02`, `dispersion: 0.4`, a long `attenuationDistance` of 1.6 so light barely picks up
a cast passing through. It exists purely as a highlight material. A cluster that's all amethyst
looks like plastic; a cluster with a third of its points clear looks like a mineral.

### Molten fissures: a ribbon that has no width

A crack is a strip of geometry along the stroke. The obvious build is to compute the two edges on
the CPU: for each centreline point, push one vertex left by `width/2` and one right. It works, and
it means the width slider rebuilds the buffer.

Instead, every vertex is placed *on the centreline* — both of them, at exactly the same position —
and the strip is pushed apart in the vertex stage:

```ts
mat.positionNode = positionLocal.add(
  aSide.mul(this.uWidth.mul(0.5).mul(aAcross).mul(aJit)).mul(taper.mul(sel)),
);
```

`aAcross` is ±1, `aSide` is the per-point across direction, `aJit` is a baked-in random walk that
gives the crack an organic, uneven width. `uWidth` is a uniform. So the crack width slider writes
one float and touches no buffers at all. A typical crack with its branches is 352 centreline
points — 704 vertices, 674 triangles — and every one of those vertices has a twin sitting at
exactly the same coordinates until the vertex shader runs.

Once you've moved width into the shader, the rest follows for free. Branches are grown at
generation time — lightning-ish walks that step across the surface, veer, and re-project onto the
sphere — and each branch carries three extra attributes: `aRank` (a random 0–1), `aWalk` (distance
from the branch origin) and `aMaxWalk`. Then:

```ts
const sel = step(aRank, this.uBranchFrac);              // branch density
const taper = float(1)
  .sub(aWalk.div(aMaxWalk.mul(this.uLenFrac).add(1e-4)))
  .clamp(0, 1)
  .pow(0.7);                                            // branch length
```

`sel` is 1 for branches whose rank survives the density slider and 0 for the rest, and a culled
branch is multiplied to zero width — it collapses into the centreline and disappears. The main
crack has rank 0, so it always survives. `taper` pinches a branch to a point wherever the length
slider currently is. Two sliders, two uniforms, zero rebuilds, and no CPU work per frame.

> 🎥 **GIF 06** — record `/demos/ribbon.html`. Tick **Source vertices** so the centreline dots are
> visible, then sweep **crack width** across its range — the dots stay put while the crack breathes.
> Then sweep **branches / unit** down to 0 and back up.

![The fissure ribbon expanding from its centreline](gifs/06-ribbon.gif)

The colour of the crack is one float. There's no texture and no light touching it. Heat is a
product of four terms, and then a ramp:

```ts
const openness = smoothstep(0.0, 0.1, this.uGrown.sub(aDist));
const center = smoothstep(0.12, 1.0, abs(aAcross)).oneMinus();
const pulse = aDist.mul(7).sub(time.mul(this.uPulse.mul(2.6))).sin().mul(0.28).add(0.72);
const flicker = time.mul(9).add(aDist.mul(41)).sin().mul(0.08).add(0.94);
const flash = smoothstep(0.0, 0.22, abs(this.uGrown.sub(aDist))).oneMinus().mul(1.6).mul(tip);

const heat = center.mul(pulse).mul(flicker).mul(this.uHeat)
  .mul(taper.mul(0.35).add(0.65))
  .mul(tip.mul(0.85).add(0.15))
  .add(flash);

const cSeam = vec3(0.02, 0.004, 0.002);
const cRed = vec3(1.1, 0.1, 0.01);
const cOrange = vec3(2.6, 0.85, 0.1);
const cWhite = vec3(4.6, 3.6, 2.4);
let color = mix(cSeam, cRed, smoothstep(0.0, 0.55, heat));
color = mix(color, cOrange, smoothstep(0.55, 1.15, heat));
color = mix(color, cWhite, smoothstep(1.15, 2.1, heat));
```

Each term has exactly one job. `center` is the cross-section — bright at the seam, gone at the
lips. `pulse` is a wave travelling along the crack, which is what makes it breathe. `flicker` is
high-frequency noise so the light never sits perfectly still. `flash` is a white-hot band riding
the propagation front, and it's the single term that makes the crack look like it's *tearing*
rather than fading in.

Those ramp colours are deliberately way above 1. `cWhite` is `(4.6, 3.6, 2.4)`, which after ACES
tone mapping clips to white and, more importantly, blows straight past the bloom threshold. The
glow isn't a post-process trick applied to the crack; the crack is genuinely that bright and bloom
is just reporting it.

> 🎥 **GIF 07** — record `/demos/blackbody.html`. Let the front sweep once with everything on, then
> untick the four terms one at a time with a beat between each — **flicker**, then **pulse**, then
> **front flash**, then **cross-section**, so the strip collapses to a flat bar. This one is worth
> doing slowly.

![Building the fissure heat ramp term by term](gifs/07-blackbody.gif)

The crack additionally uses `AdditiveBlending`, which is not just a glow decision. Where two
fissures cross — or where a branch meets its parent — the light *sums* into a hotter junction
instead of one crack's edge painting over the other. It's the sort of thing you get for free from
the right blend mode and would spend a day faking otherwise.

### Aurora silk: light the folds, not the sheet

The aurora curtain is a grid built along the stroke, with every vertex sitting at the hem. Height
and billow are applied in the vertex stage — same reasoning as the crack ribbon, so curtain height
is a live uniform:

```ts
const foldPhase = aDist.mul(6.3).add(T.mul(1.1)).add(phase);
const sway = foldPhase.sin()
  .add(aDist.mul(11.7).sub(T.mul(0.7)).add(aV.mul(1.8)).add(phase).sin().mul(0.5));
const amp = this.uWave.mul(0.17).mul(aV.pow(1.35)).mul(unfurl).mul(breath);

mat.positionNode = positionLocal
  .add(aUp.mul(lift.add(ripple.mul(0.4))))
  .add(aSide.mul(amp.mul(sway).add(ripple)));
```

The amplitude scales with `aV^1.35` — the height fraction — so the hem stays pinned to the surface
while the crest billows. Without that the whole sheet slides around like a flag that came off its
pole.

But the vertex wave alone gives you a wobbling plane, not fabric. The thing that sells it is one
line in the fragment stage:

```ts
const folds = abs(cos(foldPhase)).pow(1.6).mul(0.85).add(0.4);
```

The same `foldPhase` that displaced the vertices now drives the brightness. Where the cloth turns
away from you — where you'd be looking through more of it — it glows. And because both stages read
the same phase, the bright bands *travel with the folds* instead of sliding across them. That's
real: translucent fabric seen edge-on is brighter, and an aurora is exactly that, a curtain you're
looking at from the side.

I keep coming back to this one because it's the highest ratio of "visual payoff" to "characters
typed" in the whole project. One shared variable between two shader stages.

> 🎥 **GIF 08** — record `/demos/fold-light.html`. Let both curtains run side by side for a few
> seconds, then slowly drag **fragment phase offset** from 0 up to about 1π. The right curtain
> stops being cloth as the light detaches from the geometry.

![Fold-locked brightness versus even brightness](gifs/08-fold-light.gif)

Two curtains are drawn from the same geometry with different phases and statures — a front sheet
and a shorter, dimmer back sheet — which reads as separate bands of one aurora rather than a single
flat plane. Cheapest depth you'll ever buy: one extra draw call, one changed constant.

### The reef: one heartbeat for the whole thing

The bioluminescent reef is the most conventional geometry in the project — recursively branched
staghorn corals, anemone tendrils, canvas-drawn gorgonian fans — and the least conventional
lighting logic.

The polyps don't blink on their own clocks. Their brightness is read out of a wave that lives in
world space:

```ts
function colonyPulse() {
  return positionWorld.dot(vec3(1.6, 1.1, 1.35)).mul(2.6)
    .sub(time.mul(uPulse.mul(2.1)))
    .sin().mul(0.5).add(0.5).pow(2.5);
}
```

Project world position onto a direction, subtract time, take the sine, sharpen it with a `pow`.
The result is a plane wave sweeping through the scene, and every polyp, tendril tip and fan vein in
every stroke samples the same wave.

The consequence is the good part. Paint a colony on the left of the sphere and another on the right
five minutes later, and they pulse *in the right order* — the wave reaches one, then the other,
with the delay you'd expect from the distance between them. Nobody wired that up. It falls out of
sampling a shared field instead of giving each object a phase. On top of it each polyp gets a small
per-instance blink from `hash(instanceIndex)`, so the reef breathes as one organism made of
individually twitchy parts.

The `pow(2.5)` is doing quiet work: it turns a sine's lazy round hump into a sharp crest with long
dark troughs. Bioluminescence is a *flash* with a slow recovery, not a dimmer being turned up and
down.

> 🎥 **GIF 09** — record `/demos/colony-pulse.html`. Watch a couple of wave passes in world mode —
> the floor is shaded with the same expression, so you can see the front arrive before the colonies
> light. Then untick **world-space wave** and let it run: three unrelated blinkers.

![One world-space wave driving three separate colonies](gifs/09-colony-pulse.gif)

---

## The look

### The environment is the lighting

Crystals are reflection. Almost everything you see on them is not shading, it's a picture of the
room. So the room is the thing worth building, and it's six emissive quads:

```ts
panel(0xfff6ea, 9, 4.5, 3, [1.5, 8, 2]);      // overhead softbox, biased toward camera
panel(0xffffff, 22, 0.7, 4.5, [-2.5, 5, -6]); // hard top-back strip — facet glints
panel(0x9db8ff, 5, 1.2, 7, [-7, 2, -2]);      // cool strip, camera-left
panel(0xffd9b0, 3.5, 1.6, 5, [6, 1.5, 3]);    // warm strip, camera-right
panel(0x8a5cff, 4, 6, 3.5, [0, 2.5, -8]);     // violet wash behind the subject
panel(0x2e3c58, 1.2, 9, 9, [0, -5, 0]);       // dim floor bounce

const pmrem = new THREE.PMREMGenerator(this.renderer);
this.scene.environment = pmrem.fromScene(env, 0.04).texture;
```

`MeshBasicMaterial` with a colour multiplied past 1, prefiltered by `PMREMGenerator`. That's the
whole studio. The intensities aren't arbitrary — that 22 on the narrow top-back strip is what
produces the hard specular glints along the crystal facet edges, and it has to be that bright
because the strip is 0.7 units wide and mostly misses. If you've ever lit a product shot this will
all feel familiar: big soft key, hard rim, cool/warm separation, and a wash behind to lift the
subject off the background.

The three *actual* lights in the scene do a different job. The key spot casts the soft shadow
under the floating sphere. The rear pair — a blue-ish directional plus a violet kicker — exist
because transmission responds to light arriving from *behind* the surface, so they're what make the
crystals light up from inside. That's why "backlight" is a slider in the UI and "key light" isn't.

> 🎥 **GIF 10** — record `/demos/studio.html`. Tick **Show the panels** so the room is visible,
> then switch the panels off one at a time — start with the **hard top-back strip**, since that's
> the one whose disappearance is most obvious on the facets.

![The environment panels and the highlights they produce](gifs/10-studio.gif)

### Post

Four things, in one node graph:

```ts
const scenePass = pass(this.scene, this.camera, { samples: 4 });
const color = scenePass.getTextureNode();
this.bloomNode = bloom(color, this.settings.bloomStrength, 0.6, this.settings.bloomThreshold);
const vignette = float(1).sub(smoothstep(0.5, 0.92, screenUV.distance(vec2(0.5, 0.5))).mul(0.35));
this.post.outputNode = color.add(this.bloomNode).mul(vignette);
```

MSAA at 4 samples on the scene pass, bloom picking up anything above threshold, a 35% vignette into
the corners, and ACES filmic tone mapping on output. The vignette is the cheapest "this was shot
with a fast lens" signal there is and I'd put it on everything if I could.

---

## Refinement

### The one place a rebuild is unavoidable

Reseeding genuinely regenerates — new random numbers means new geometry, there's no way around it.
And a few settings on some modes can't be re-derived in place, which is what the optional
`applySettings?` is for. So there's one rebuild path, and it's throttled adaptively:

```ts
const interval = this.regrowPending.mode === 'animate'
  ? 0
  : THREE.MathUtils.clamp(this.regrowCost * 3, 60, 400);
if (now - this.lastRegrowAt >= interval) {
  const t0 = performance.now();
  this.regrow(req.mode === 'animate');
  this.regrowCost = performance.now() - t0;   // measure, then back off proportionally
  this.lastRegrowAt = performance.now();
}
```

Requests are coalesced into a single pending flag and serviced in the tick, and the interval is
derived from how long the *last* rebuild actually took. An empty scene rebuilds every 60ms and
feels instant; a sphere covered in reef colonies backs off toward 400ms and stays draggable. It
adapts to the machine as well as to the scene, which beats any constant I could have picked.

### Two WebGPU things that will catch you

**Points are one pixel.** `PointsMaterial` with `size: 0.02` and `sizeAttenuation: true` renders
as a single pixel per point under the WebGPU backend — point primitives don't have a size. The
embers and plankton and star motes in this project are all instanced quads with a soft radial
sprite. They don't even billboard; each one gets a fixed random orientation at spawn, which reads
completely fine for a spark and saves updating a rotation every frame for hundreds of particles.

**Line width is ignored.** Same story. The violet trail that follows your cursor while you paint
was a `Line` with `linewidth: 3` for about ten minutes before I noticed it was hairline-thin. It's
now an `InstancedMesh` of overlapping spheres — one bead per sample, radius chosen so consecutive
beads overlap and read as a continuous stroke:

```ts
this.beads = new THREE.InstancedMesh(
  new THREE.SphereGeometry(STROKE_RADIUS, 12, 8), glow({ opacity: 1 }), MAX_BEADS,
);
for (let i = 0; i < MAX_BEADS; i++) this.beads.setMatrixAt(i, this.zeroMat);
this.beads.count = 0;
```

Note the pre-zeroing of the whole buffer up front. Instance matrices are uninitialised garbage
otherwise, and raising `count` mid-stroke will happily draw a unit-scale sphere at the origin from
whatever was left in memory. Zero it once at construction and the class of bug goes away.

### What's missing

I'd rather say this than have it found: there's no keyboard path to painting. You can toggle modes
with **D**, you can drive every parameter from the GUI, but the stroke itself requires a pointer.
The honest fix isn't a keyboard-driven cursor — it's a small set of preset strokes ("paint an arc
across the equator") that go through the exact same `addStroke(samples)` entry point the pointer
uses. The plumbing is already there; the samples don't care where they came from. It's on the list.

There's also no `prefers-reduced-motion` handling. The sphere's idle bob and the drifting dust are
both small, but "small" isn't a judgement I get to make for someone with a vestibular disorder.
Both are one conditional away from being switchable, and both should be.

---

## Wrapping up

The thing I'd take from this project to the next one isn't a shader. It's the constraint. "No
allocation while a slider is moving" sounded like a performance rule when I wrote it down, and it
turned out to be a *design* rule — it forced every mode into a shape where its look is a pure
function of stable per-instance randoms plus current settings. Once you're in that shape, live
editing, deterministic replay, seed-based variation and undo all stop being features you implement
and start being things that are simply true.

A few things worth trying if you clone it:

- **Write a mode.** Implement `createStroke` and add one line to the registry. Mushrooms, circuitry,
  frost, feathers, fungal networks — the samples don't care.
- **Swap the canvas.** Nothing in the painting code knows it's a sphere. Load a mesh, run
  `indexForRaycasts` on it, and the only thing that breaks is the fissure branch walker, which
  re-projects onto a sphere of radius `|origin|` and would need a proper surface-walk for
  arbitrary geometry.
- **Push the pulse further.** The reef's world-space wave is a template. A shared field that every
  mode samples — wind, tide, a light source moving through the scene — would tie four unrelated
  effects into one world with about thirty lines.

---

## Credits

- Built with [three.js](https://threejs.org/) (WebGPU renderer + TSL), [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh)
  for accelerated picking, and [lil-gui](https://lil-gui.georgealways.com/).
- Growth easing is a variant of the standard `easeOutBack` from [easings.net](https://easings.net/).
- The random generator is Tommy Ettinger's mulberry32.
- Lighting approach borrowed wholesale from product photography, which is a much older field than
  ours and has already solved most of it.

*A note on the demo pages: add `?still=4` to any of their URLs to simulate four seconds, render a
single frame and stop. I added it so a headless browser could screenshot them — an endless
`requestAnimationFrame` loop never lets the page go idle, so the capture never fires — and then
found it was the fastest way to grab a still for this article.*

---

*Author bio goes here — a couple of sentences, plus Website / X / LinkedIn / GitHub links.*

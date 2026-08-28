import { defineConfig } from 'vite';

/** Every page under /demos is its own entry, so `npm run build` ships them all. */
const DEMOS = [
  'index',
  'picking',
  'anchor-space',
  'resample',
  'cull',
  'growth',
  'ribbon',
  'blackbody',
  'fold-light',
  'colony-pulse',
  'studio',
];

export default defineConfig({
  resolve: {
    // Addons (OrbitControls, tsl display nodes, ...) import from 'three'. Route that to the
    // WebGPU build so the whole app shares a single module instance of three.
    alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: 'index.html',
        ...Object.fromEntries(DEMOS.map((d) => [`demo-${d}`, `demos/${d}.html`])),
      },
    },
  },
});

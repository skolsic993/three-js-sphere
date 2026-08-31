import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "esnext",
    rollupOptions: {
      input: {
        main: "index.html",
        cluster: "cluster.html",
      },
    },
  },
});

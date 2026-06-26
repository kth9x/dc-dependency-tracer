import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Scene3D is code-split into its own chunk and lazy-loaded behind <Suspense>,
// exactly like the original (index chunk ~small, Scene3D chunk holds three.js).
//
// `base`: GitHub Pages serves a project site under /<repo>/, so the production
// build is rooted there; the dev server stays at "/". Override the build base
// with the BASE_PATH env var if you deploy under a different path.
export default defineConfig(({ command }) => ({
  base:
    command === "build" ? process.env.BASE_PATH ?? "/dc-dependency-tracer/" : "/",
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three", "@react-three/fiber", "@react-three/drei"],
        },
      },
    },
  },
}));

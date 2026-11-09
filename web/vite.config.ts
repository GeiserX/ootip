import { defineConfig } from "vite";

// Served from GitHub Pages at /ootip/.
export default defineConfig({ base: "./", build: { target: "es2022" } });

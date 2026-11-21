import { defineConfig } from 'vite';

// GitHub Pages serves this repo as a project site under
// /frozen-in-flames-studio/, so the Pages workflow builds with
// GITHUB_PAGES=1 to set the asset base. Every other build (local dev,
// the Hugging Face Space) keeps the root base.
export default defineConfig({
  base: process.env.GITHUB_PAGES ? '/frozen-in-flames-studio/' : '/',
  test: {
    environment: 'node',
  },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Pulse (default) deploys at /book-pm-management/pulse/.
// The York U Fitness class variant (mode "yorku") deploys to a /yorku/
// subpath alongside it, so both ship from the same GitHub Pages site.
export default defineConfig(({ mode }) => {
  const isYorku = mode === 'yorku';
  return {
    plugins: [react()],
    base: isYorku
      ? '/book-pm-management/pulse/yorku/'
      : '/book-pm-management/pulse/',
    build: {
      outDir: isYorku ? 'dist/pulse/yorku' : 'dist/pulse',
      emptyOutDir: true,
    },
  };
});

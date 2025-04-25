import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      // Allow serving from project root /plugins folder
      allow: ['.', '..']
    }
  }
});

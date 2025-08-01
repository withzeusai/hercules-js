import { defineConfig } from 'vite';
import herculesPlugin from '../src/index';

export default defineConfig({
  plugins: [
    // Example usage of the Hercules plugin
    herculesPlugin({
      debug: true,
      message: 'Hercules plugin loaded successfully!'
    })
  ],
  
  // Example Vite 6 configuration
  build: {
    target: 'baseline-widely-available', // New Vite 6 default target
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom']
        }
      }
    }
  },

  server: {
    port: 3000,
    open: true
  }
}); 
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname, "src/renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
    // STT is loaded only after voice input is used. Keep Transformers and its
    // ONNX runtime out of the initial renderer chunk, even if other renderer
    // modules later gain an incidental import of either package.
    rollupOptions: {
      output: {
        manualChunks: {
          stt: ["@huggingface/transformers", "onnxruntime-web"]
        }
      }
    },
    // The STT chunk is intentionally lazy-loaded; warn on growth beyond 1 MB
    // rather than treating its current isolated size as an initial-load issue.
    chunkSizeWarningLimit: 1_000
  },
  server: {
    port: 5173,
    strictPort: true
  }
});

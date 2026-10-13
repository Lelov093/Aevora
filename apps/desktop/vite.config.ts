import { defineConfig } from "vite";
export default defineConfig({ server: { host: "127.0.0.1", port: 1420, strictPort: true }, clearScreen: false,
  build: { rollupOptions: { output: { manualChunks: { markdown: ['react-markdown','remark-gfm'] } } } }
});

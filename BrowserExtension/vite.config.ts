import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

// Loaded unpacked from dist/: the service worker is one bundle and the manifest (with its pinned `key`) sits next to it.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: "src/background.ts",
      output: { entryFileNames: "background.js" },
    },
  },
  plugins: [
    {
      name: "emit-manifest",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "manifest.json",
          source: readFileSync("manifest.json", "utf8"),
        });
      },
    },
  ],
});

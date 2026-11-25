import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

// Loaded unpacked from dist/: the service worker is one bundle and the manifest (with its pinned `key`) sits next to it.
// The content scripts are injected as plain files, so each is a self-contained IIFE bundle built by its own run
// (`vite build --mode <name>`); chunks shared between entries are what a content script can't load.
const CONTENT_SCRIPTS: Record<string, string> = {
  "main-world": "src/content/main-world.ts",
  "isolated-world": "src/content/isolated-world.ts",
};

export default defineConfig(({ mode }) => {
  const content = CONTENT_SCRIPTS[mode];
  if (content) {
    return {
      publicDir: false,
      build: {
        outDir: "dist",
        emptyOutDir: false,
        target: "es2022",
        lib: { entry: content, formats: ["iife"], name: "finetune", fileName: () => `${mode}.js` },
      },
    };
  }
  return {
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
  };
});

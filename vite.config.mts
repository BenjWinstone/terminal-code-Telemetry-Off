import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** One page per invocation, so every page lands as its own self-contained
 * bundle — no chunks shared between pages, no hashed filenames, nothing to
 * serve but one html, one js and one css per page:
 *
 *   TODE_PAGE=shortcuts vite build && TODE_PAGE=import vite build
 *
 * (npm run build:pages). The outputs land in assets/pages/<name>, which is
 * how every other static file tode serves already travels. */
const page = process.env.TODE_PAGE;
if (!page) throw new Error("set TODE_PAGE to the page to build (shortcuts, import)");

export default defineConfig({
  root: path.join(__dirname, "src", "pages", page),
  plugins: [react()],
  logLevel: "warn",
  build: {
    outDir: path.join(__dirname, "assets", "pages", page),
    emptyOutDir: true,
    target: "es2022",
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});

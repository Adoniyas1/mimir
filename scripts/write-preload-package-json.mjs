// Marks dist/preload as CommonJS regardless of the root package.json's
// "type": "module" — Electron loads preload scripts via require(), which
// can't load an ES module. See tsconfig.preload.json + src/preload/index.ts
// for the rest of this boundary.
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("dist/preload", { recursive: true });
writeFileSync("dist/preload/package.json", JSON.stringify({ type: "commonjs" }, null, 2) + "\n");

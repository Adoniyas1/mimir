import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "node_modules", "@ricky0123", "vad-web", "dist");
const ortSource = path.join(root, "node_modules", "@ricky0123", "vad-web", "node_modules", "onnxruntime-web", "dist");
const output = path.join(root, "src", "renderer", "public", "vad");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await Promise.all([
  copyFile(path.join(source, "silero_vad_v5.onnx"), path.join(output, "silero_vad_v5.onnx")),
  copyFile(path.join(source, "vad.worklet.bundle.min.js"), path.join(output, "vad.worklet.bundle.min.js"))
]);

for (const file of await readdir(ortSource)) {
  if (file.startsWith("ort-") && (file.endsWith(".wasm") || file.endsWith(".mjs"))) {
    await copyFile(path.join(ortSource, file), path.join(output, file));
  }
}

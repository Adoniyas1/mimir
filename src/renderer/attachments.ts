import type { Attachment } from "../shared/types.js";

/** Matches Anthropic's own document/image size ceiling — no point accepting
 * a file the model couldn't read anyway. */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const TEXT_EXTENSIONS = /\.(md|txt|py|ts|tsx|js|jsx|json|csv|c|cpp|h|hpp|java|m|matlab|rs|go|sh|yaml|yml|toml|ini|log)$/i;

export class AttachmentTooLargeError extends Error {}

/** Converts a browser File into the wire format every BrainProvider
 * understands — see the Attachment doc comment in src/shared/types.ts. */
export async function fileToAttachment(file: File): Promise<Attachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentTooLargeError(`${file.name} is ${Math.round(file.size / 1024 / 1024)}MB — the limit is 20MB.`);
  }

  if (file.type.startsWith("image/")) {
    return { kind: "image", mimeType: file.type, data: await toBase64(file), name: file.name };
  }
  if (file.type === "application/pdf") {
    return { kind: "document", mimeType: file.type, data: await toBase64(file), name: file.name };
  }
  if (file.type.startsWith("text/") || TEXT_EXTENSIONS.test(file.name) || file.type === "") {
    return { kind: "text", mimeType: file.type || "text/plain", data: await file.text(), name: file.name };
  }
  // Unknown binary type (e.g. .docx) — no extraction pipeline for this yet;
  // still attach as base64 "document" so at least Claude's document support
  // has a shot at it, rather than silently refusing the file.
  return { kind: "document", mimeType: file.type || "application/octet-stream", data: await toBase64(file), name: file.name };
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

// File upload handling (concept: file_upload_path).
import path from "node:path";
import { sanitizeInput } from "../utils/inputValidator";

const UPLOAD_ROOT = "/var/data/uploads";

export function saveUploadedFile(filename: string, buffer: Buffer): string {
  const safeName = sanitizeInput(filename);
  const destination = resolveUploadPath(safeName);
  writeFileToDisk(destination, buffer);
  return destination;
}

function resolveUploadPath(safeName: string): string {
  const joined = path.join(UPLOAD_ROOT, safeName);
  if (!joined.startsWith(UPLOAD_ROOT)) {
    throw new Error("path traversal rejected");
  }
  return joined;
}

function writeFileToDisk(destination: string, buffer: Buffer): void {
  // Placeholder for fs.writeFileSync(destination, buffer) — fixture only.
  void destination;
  void buffer;
}

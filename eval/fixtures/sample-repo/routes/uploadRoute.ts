// Upload route — wires upload handling and shell post-processing together.
import { saveUploadedFile } from "../api/uploadHandler";
import { runShellCommand } from "../api/execTool";
import { auditLog } from "../utils/auditLogger";

export function handleUpload(filename: string, buffer: Buffer): string {
  const destination = saveUploadedFile(filename, buffer);
  runShellCommand("ffprobe", [destination]);
  auditLog("file_uploaded", { destination });
  return destination;
}

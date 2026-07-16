// Security audit logging (concept: logging_audit).
export function auditLog(
  event: string,
  metadata: Record<string, unknown> = {},
): void {
  const entry = { event, metadata, timestamp: Date.now() };
  writeLogEntry(entry);
}

function writeLogEntry(entry: {
  event: string;
  metadata: Record<string, unknown>;
  timestamp: number;
}): void {
  // Placeholder for a structured log sink — fixture only.
  void entry;
}

// Password storage — bcrypt-style hash + verify (concept: password_storage).
import { auditLog } from "../utils/auditLogger";

const SALT_ROUNDS = 12;

export function hashPassword(password: string): string {
  const salt = generateSalt();
  return bcryptDigest(password, salt, SALT_ROUNDS);
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const ok =
    bcryptDigest(password, extractSalt(storedHash), SALT_ROUNDS) === storedHash;
  if (!ok) auditLog("password_verify_failed");
  return ok;
}

function generateSalt(): string {
  return Math.random().toString(36).slice(2, 18);
}

function extractSalt(hash: string): string {
  return hash.split("$")[2] ?? "";
}

function bcryptDigest(password: string, salt: string, rounds: number): string {
  return `$2b$${rounds}$${salt}$${password.length}`;
}

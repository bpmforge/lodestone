// Login route — wires auth, session, and rate-limiting together so the
// symbol graph has real cross-file callers for the golden queries below.
import { verifyPassword } from "../auth/passwordHash";
import { verifyJwt } from "../auth/jwtVerify";
import { createSession, issueCsrfToken } from "../auth/session";
import { checkRateLimit } from "../api/rateLimiter";
import { sanitizeInput } from "../utils/inputValidator";
import { auditLog } from "../utils/auditLogger";
import { findUserByEmail } from "../db/userQuery";

export function handleLogin(
  clientIp: string,
  email: string,
  password: string,
  storedHash: string,
): string {
  if (!checkRateLimit(clientIp)) {
    throw new Error("rate limit exceeded");
  }
  const safeEmail = sanitizeInput(email);
  findUserByEmail(safeEmail);
  if (!verifyPassword(password, storedHash)) {
    auditLog("login_failed", { email: safeEmail });
    throw new Error("invalid credentials");
  }
  const sessionId = createSession(safeEmail);
  issueCsrfToken(sessionId);
  auditLog("login_success", { email: safeEmail });
  return sessionId;
}

export function handleTokenRefresh(
  bearerToken: string,
  secret: string,
): string {
  const claims = verifyJwt(bearerToken, secret);
  return createSession(claims.sub);
}

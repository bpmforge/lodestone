// Session + CSRF token management (concept: session_management).
const sessions = new Map<string, { userId: string; expiresAt: number }>();
const csrfTokens = new Map<string, string>();

export function createSession(userId: string): string {
  const sessionId = randomSessionId();
  sessions.set(sessionId, { userId, expiresAt: Date.now() + 3600_000 });
  return sessionId;
}

export function revokeSession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function issueCsrfToken(sessionId: string): string {
  const token = randomSessionId();
  csrfTokens.set(sessionId, token);
  return token;
}

export function validateCsrfToken(
  sessionId: string,
  candidate: string,
): boolean {
  return csrfTokens.get(sessionId) === candidate;
}

function randomSessionId(): string {
  return Math.random().toString(36).slice(2, 26);
}

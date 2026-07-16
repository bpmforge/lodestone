// Rate limiting (concept: rate_limiting_dos).
const requestCounts = new Map<string, { count: number; windowStart: number }>();
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 100;

export function checkRateLimit(clientIp: string): boolean {
  const now = Date.now();
  const bucket = requestCounts.get(clientIp);
  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    requestCounts.set(clientIp, { count: 1, windowStart: now });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= MAX_REQUESTS_PER_WINDOW;
}

export function resetRateLimit(clientIp: string): void {
  requestCounts.delete(clientIp);
}

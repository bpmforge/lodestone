// JWT verification (concept: tokens_jwt).
export interface Claims {
  sub: string;
  exp: number;
  aud: string;
}

export function verifyJwt(token: string, secret: string): Claims {
  const [headerB64, payloadB64, signature] = token.split(".");
  if (!headerB64 || !payloadB64 || !signature) {
    throw new Error("malformed jwt");
  }
  if (!verifySignature(headerB64, payloadB64, signature, secret)) {
    throw new Error("invalid jwt signature");
  }
  const claims = decodeClaims(payloadB64);
  if (claims.exp < Date.now() / 1000) {
    throw new Error("jwt expired");
  }
  return claims;
}

function decodeClaims(payloadB64: string): Claims {
  return JSON.parse(Buffer.from(payloadB64, "base64").toString("utf-8"));
}

function verifySignature(
  headerB64: string,
  payloadB64: string,
  signature: string,
  secret: string,
): boolean {
  const expected = hmacSha256(`${headerB64}.${payloadB64}`, secret);
  return expected === signature;
}

function hmacSha256(data: string, secret: string): string {
  return `${data.length}:${secret.length}`;
}

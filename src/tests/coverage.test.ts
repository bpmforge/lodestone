import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { CodeSearchDb } from "../db.js";
import { indexPath } from "../indexer.js";
import { coverageGaps } from "../packet/coverage.js";
import { parseOntology } from "../ontology/index.js";
import type { EmbeddingProvider } from "../embeddings/index.js";
import type { Finding } from "../packet/index.js";

// W4-02: coverageGaps(db, findings) — the deterministic present-but-uncovered
// escalation signal. See packet/coverage.ts module doc.

const fakeProvider: EmbeddingProvider = {
  name: "fake",
  dim: 8,
  async embed(texts: string[]) {
    return texts.map((t) => {
      const v = new Array(8).fill(0);
      for (let i = 0; i < t.length; i++) v[i % 8] += t.charCodeAt(i) % 7;
      return v;
    });
  },
  async isAvailable() {
    return true;
  },
};

function tempRepo(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coverage-fixture-"));
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function tempDb(): { db: CodeSearchDb; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coverage-db-"));
  const db = new CodeSearchDb(path.join(dir, "index.db"));
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("coverageGaps() — present-but-unscanned concept escalation signal", () => {
  let repo: ReturnType<typeof tempRepo>;
  let dbHandle: ReturnType<typeof tempDb>;
  let authPath: string;

  beforeEach(async () => {
    repo = tempRepo();
    dbHandle = tempDb();
    authPath = path.join(repo.dir, "auth.ts");

    // Auth code: hits authentication (login/authenticate), password_storage
    // (password/hash/bcrypt), and tokens_jwt (jwt/bearer/access_token) — but
    // no findings will be seeded for any of them in most tests below.
    fs.writeFileSync(
      authPath,
      `
export function login(username: string, password: string): boolean {
  return authenticate(username, password);
}

function authenticate(username: string, password: string): boolean {
  return hashPassword(password).length > 0;
}

function hashPassword(password: string): string {
  // bcrypt hash with a random salt
  return bcryptHash(password);
}

function bcryptHash(pw: string): string {
  return pw;
}

export function verifyJwt(token: string): boolean {
  // bearer access_token verification
  return token.startsWith("bearer");
}
`,
    );

    await indexPath(repo.dir, dbHandle.db, fakeProvider);
  });

  afterEach(() => {
    repo.cleanup();
    dbHandle.cleanup();
  });

  it("reports authentication/password_storage/tokens_jwt as gaps when auth code has no auth findings", () => {
    const gaps = coverageGaps(dbHandle.db, []);
    const keys = gaps.map((g) => g.concept);

    expect(keys).toContain("authentication");
    expect(keys).toContain("password_storage");
    expect(keys).toContain("tokens_jwt");

    // Each gap carries its concept's CWE anchors and at least one matched term.
    const auth = gaps.find((g) => g.concept === "authentication");
    expect(auth?.cwe).toEqual(expect.arrayContaining([287]));
    expect(auth?.matchedTerms.length).toBeGreaterThan(0);
  });

  it("does NOT flag a concept absent from the code (e.g. payment_billing, xxe_xml)", () => {
    const gaps = coverageGaps(dbHandle.db, []);
    const keys = gaps.map((g) => g.concept);

    expect(keys).not.toContain("payment_billing");
    expect(keys).not.toContain("xxe_xml");
  });

  it("does NOT flag a concept that is present AND covered by a finding (direct concept match)", () => {
    const finding: Finding = {
      path: authPath,
      line: 12,
      ruleId: "bpm-owasp-weak-hash",
      concept: "password_storage",
    };

    const gaps = coverageGaps(dbHandle.db, [finding]);
    const keys = gaps.map((g) => g.concept);

    expect(keys).not.toContain("password_storage");
    // authentication is present but still has no covering finding — stays a gap.
    expect(keys).toContain("authentication");
  });

  it("does NOT flag a concept covered via CWE overlap even without an explicit concept match", () => {
    // authentication's CWE anchors are [287, 306, 307] (ontology/concepts.yaml).
    const finding: Finding = {
      path: authPath,
      line: 2,
      ruleId: "bpm-owasp-missing-auth",
      cwe: [287],
    };

    const gaps = coverageGaps(dbHandle.db, [finding]);
    const keys = gaps.map((g) => g.concept);

    expect(keys).not.toContain("authentication");
    // Unrelated present concepts (no CWE overlap) remain gaps.
    expect(keys).toContain("password_storage");
  });

  it("respects a custom ontology instead of the default 42-concept one", () => {
    const ontology = parseOntology(`
version: 0.1
concepts:
  widgets:
    cwe: [1]
    terms: [widget, gadget_maker]
    packages: {}
  authentication:
    cwe: [287]
    terms: [login, authenticate]
    packages: {}
`);

    const gaps = coverageGaps(dbHandle.db, [], ontology);
    const keys = gaps.map((g) => g.concept);

    // "widgets" terms never appear in the auth fixture — absent, not a gap.
    expect(keys).not.toContain("widgets");
    // "authentication" terms do appear, no finding covers it — a gap.
    expect(keys).toContain("authentication");
  });
});

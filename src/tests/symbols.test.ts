import { describe, it, expect } from "vitest";
import { extractSymbols } from "../symbols/extractor.js";

const ts = (src: string) => extractSymbols(src, "file.ts");
const py = (src: string) => extractSymbols(src, "file.py");
const go = (src: string) => extractSymbols(src, "file.go");
const rs = (src: string) => extractSymbols(src, "file.rs");
const md = (src: string) => extractSymbols(src, "file.md");

describe("TypeScript/JavaScript extractor", () => {
  it("extracts exported function", () => {
    const syms = ts(
      "export function authenticate(token: string): boolean {\n  return true;\n}",
    );
    expect(syms).toHaveLength(1);
    expect(syms[0]).toMatchObject({
      name: "authenticate",
      kind: "function",
      line: 1,
    });
  });

  it("extracts async arrow exported as const", () => {
    const syms = ts(
      "export const fetchUser = async (id: string) => {\n  return null;\n};",
    );
    expect(syms[0]).toMatchObject({ name: "fetchUser", kind: "function" });
  });

  it("extracts exported class", () => {
    const syms = ts("export class UserService {\n  async getUser() {}\n}");
    expect(syms.find((s) => s.kind === "class")).toMatchObject({
      name: "UserService",
    });
  });

  it("extracts interface", () => {
    const syms = ts("export interface AuthConfig {\n  secret: string;\n}");
    expect(syms[0]).toMatchObject({ name: "AuthConfig", kind: "interface" });
  });

  it("extracts type alias", () => {
    const syms = ts("export type UserId = string;");
    expect(syms[0]).toMatchObject({ name: "UserId", kind: "type" });
  });

  it("extracts enum", () => {
    const syms = ts("export enum Status {\n  Active,\n  Inactive,\n}");
    expect(syms[0]).toMatchObject({ name: "Status", kind: "enum" });
  });

  it("extracts class method", () => {
    const src =
      "class Foo {\n  async handleRequest(req: Request) {\n    return null;\n  }\n}";
    const syms = ts(src);
    const method = syms.find((s) => s.kind === "method");
    expect(method).toMatchObject({ name: "handleRequest" });
  });

  it("does not extract constructor or super as symbols", () => {
    const src = "class Foo {\n  constructor() {}\n  super() {}\n}";
    const syms = ts(src);
    expect(
      syms.every((s) => s.name !== "constructor" && s.name !== "super"),
    ).toBe(true);
  });

  it("returns line numbers correctly (1-based)", () => {
    const src = "\n\nexport function third() {}";
    const syms = ts(src);
    expect(syms[0].line).toBe(3);
  });
});

describe("Python extractor", () => {
  it("extracts top-level function", () => {
    const syms = py("def process_data(items):\n    return items");
    expect(syms[0]).toMatchObject({ name: "process_data", kind: "function" });
  });

  it("extracts async function", () => {
    const syms = py("async def fetch_user(id: str) -> dict:\n    pass");
    expect(syms[0]).toMatchObject({ name: "fetch_user", kind: "function" });
  });

  it("extracts class", () => {
    const syms = py("class UserService:\n    pass");
    expect(syms[0]).toMatchObject({ name: "UserService", kind: "class" });
  });

  it("extracts method inside class", () => {
    const src = "class Foo:\n    def bar(self):\n        pass";
    const syms = py(src);
    expect(syms.find((s) => s.kind === "method")).toMatchObject({
      name: "bar",
    });
  });
});

describe("Go extractor", () => {
  it("extracts plain function", () => {
    const syms = go(
      "func ProcessRequest(w http.ResponseWriter, r *http.Request) {\n}",
    );
    expect(syms[0]).toMatchObject({ name: "ProcessRequest", kind: "function" });
  });

  it("extracts method with receiver", () => {
    const syms = go(
      "func (s *UserService) GetUser(id string) (*User, error) {\n}",
    );
    expect(syms[0]).toMatchObject({ name: "GetUser", kind: "function" });
  });

  it("extracts struct", () => {
    const syms = go("type UserService struct {\n  db *sql.DB\n}");
    expect(syms[0]).toMatchObject({ name: "UserService", kind: "struct" });
  });

  it("extracts interface", () => {
    const syms = go(
      "type Repository interface {\n  Find(id string) (*User, error)\n}",
    );
    expect(syms[0]).toMatchObject({ name: "Repository", kind: "interface" });
  });
});

describe("Rust extractor", () => {
  it("extracts public function", () => {
    const syms = rs("pub fn authenticate(token: &str) -> bool {\n  true\n}");
    expect(syms[0]).toMatchObject({ name: "authenticate", kind: "function" });
  });

  it("extracts struct", () => {
    const syms = rs("pub struct UserService {\n  db: Arc<Database>,\n}");
    expect(syms[0]).toMatchObject({ name: "UserService", kind: "struct" });
  });

  it("extracts trait", () => {
    const syms = rs(
      "pub trait Repository {\n  fn find(&self, id: &str) -> Option<User>;\n}",
    );
    expect(syms[0]).toMatchObject({ name: "Repository", kind: "trait" });
  });

  it("extracts impl block", () => {
    const syms = rs(
      "impl UserService {\n  pub fn new() -> Self { Self {} }\n}",
    );
    expect(syms[0]).toMatchObject({ name: "UserService", kind: "impl" });
  });

  it("extracts enum", () => {
    const syms = rs("pub enum Status {\n  Active,\n  Inactive,\n}");
    expect(syms[0]).toMatchObject({ name: "Status", kind: "enum" });
  });
});

describe("Markdown extractor", () => {
  it("extracts headings as sections", () => {
    const src = "# Title\n\nSome text.\n\n## Sub-section\n\n### Nested";
    const syms = md(src);
    expect(syms).toHaveLength(3);
    expect(syms[0]).toMatchObject({ name: "Title", kind: "section", line: 1 });
    expect(syms[1]).toMatchObject({
      name: "Sub-section",
      kind: "section",
      line: 5,
    });
    expect(syms[2]).toMatchObject({ name: "Nested", kind: "section", line: 7 });
  });
});

describe("Unknown extension", () => {
  it("returns empty for unsupported file types", () => {
    const syms = extractSymbols("some content here", "file.xyz");
    expect(syms).toHaveLength(0);
  });
});

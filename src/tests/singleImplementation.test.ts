import { describe, it, expect } from "vitest";
import { computeSingleImplementation } from "../metrics/singleImplementation.js";

describe("computeSingleImplementation — R-05 single-implementation abstraction", () => {
  it("flags an interface with exactly one implementor", async () => {
    const src = `
export interface PaymentProcessor {
  charge(amount: number): void;
}

export class StripeProcessor implements PaymentProcessor {
  charge(amount: number): void {}
}
`;
    const findings = await computeSingleImplementation([
      { path: "src/payments.ts", content: src },
    ]);

    const hit = findings.find((f) => f.symbol === "PaymentProcessor");
    expect(hit).toBeDefined();
    expect(hit!.rule).toBe("R-05");
    expect(hit!.kind).toBe("interface");
    expect(hit!.implementor).toBe("StripeProcessor");
    expect(hit!.path).toBe("src/payments.ts");
  });

  it("flags an abstract class with exactly one subclass", async () => {
    const src = `
export abstract class BaseRepository {
  abstract find(id: string): unknown;
}

export class UserRepository extends BaseRepository {
  find(id: string) {
    return null;
  }
}
`;
    const findings = await computeSingleImplementation([
      { path: "src/repo.ts", content: src },
    ]);

    const hit = findings.find((f) => f.symbol === "BaseRepository");
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe("abstract class");
    expect(hit!.implementor).toBe("UserRepository");
  });

  it("does NOT flag an interface with two implementations (clean case)", async () => {
    const src = `
export interface PaymentProcessor {
  charge(amount: number): void;
}

export class StripeProcessor implements PaymentProcessor {
  charge(amount: number): void {}
}

export class PaypalProcessor implements PaymentProcessor {
  charge(amount: number): void {}
}
`;
    const findings = await computeSingleImplementation([
      { path: "src/payments.ts", content: src },
    ]);

    expect(
      findings.find((f) => f.symbol === "PaymentProcessor"),
    ).toBeUndefined();
  });

  it("does NOT flag an interface with zero implementations (different problem — dead code)", async () => {
    const src = `
export interface UnusedContract {
  run(): void;
}
`;
    const findings = await computeSingleImplementation([
      { path: "src/contract.ts", content: src },
    ]);

    expect(findings.find((f) => f.symbol === "UnusedContract")).toBeUndefined();
  });

  it("does NOT flag a plain concrete class (not an interface or abstract class)", async () => {
    const src = `
export class OrderService {
  place() {}
}
`;
    const findings = await computeSingleImplementation([
      { path: "src/order.ts", content: src },
    ]);

    expect(findings).toEqual([]);
  });

  it("finds the single implementor even when it is in a different file", async () => {
    const iface = `
export interface Notifier {
  send(msg: string): void;
}
`;
    const impl = `
import { Notifier } from "./notifier";

export class EmailNotifier implements Notifier {
  send(msg: string) {}
}
`;
    const findings = await computeSingleImplementation([
      { path: "src/notifier.ts", content: iface },
      { path: "src/emailNotifier.ts", content: impl },
    ]);

    const hit = findings.find((f) => f.symbol === "Notifier");
    expect(hit).toBeDefined();
    expect(hit!.implementor).toBe("EmailNotifier");
  });

  it("does not misattribute a generic type-parameter constraint as a base class", async () => {
    // Regression case: `class Repo<T extends Bar>` must not read the
    // constraint's "extends Bar" as Repo's own heritage clause — Bar is
    // used only as a bound, never actually implemented/extended.
    const src = `
export interface Bar {
  id: string;
}

export class Repo<T extends Bar> {
  get(id: string): T | undefined {
    return undefined;
  }
}
`;
    const findings = await computeSingleImplementation([
      { path: "src/repo.ts", content: src },
    ]);

    expect(findings.find((f) => f.symbol === "Bar")).toBeUndefined();
  });

  it("returns [] for empty input", async () => {
    expect(await computeSingleImplementation([])).toEqual([]);
  });
});

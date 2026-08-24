import { describe, expect, it } from "vitest";
import { parseLenientJson } from "../src/linear.js";

describe("parseLenientJson", () => {
  it("parses valid JSON strictly", () => {
    expect(parseLenientJson<{ a: number }>('{"a": 1}')).toEqual({ a: 1 });
  });

  it("recovers from raw control characters inside string values", () => {
    const raw = '{"data":{"body":"line1\nline2\ttab\rret"}}';
    expect(parseLenientJson<{ data: { body: string } }>(raw).data.body).toBe("line1\nline2\ttab\rret");
  });

  it("drops other raw control characters inside strings", () => {
    const raw = '{"x":"ab"}';
    expect(parseLenientJson<{ x: string }>(raw).x).toBe("ab");
  });

  it("does not mangle escaped sequences in otherwise-invalid JSON", () => {
    const raw = '{"x":"already\\nescaped","y":"raw\nnewline"}';
    const parsed = parseLenientJson<{ x: string; y: string }>(raw);
    expect(parsed.x).toBe("already\nescaped");
    expect(parsed.y).toBe("raw\nnewline");
  });

  it("still throws on structurally broken JSON", () => {
    expect(() => parseLenientJson("{nope")).toThrow();
  });
});

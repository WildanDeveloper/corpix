import { describe, expect, it } from "vitest";
import { DEFAULT_PALETTE, ROLE_PALETTES, drawFrame, hexToRgb, paletteFor } from "../apps/web/src/office/sprites";

describe("sprite generation", () => {
  it("parses hex colours", () => {
    expect(hexToRgb("#ff8000")).toEqual([255, 128, 0]);
  });

  it("gives every team role its own palette", () => {
    const shirts = new Set<string>();
    for (const role of ["boss", "frontend", "backend", "devops", "qa", "docs"]) {
      shirts.add(paletteFor(role).shirt);
    }
    expect(shirts.size).toBe(6);
    expect(paletteFor("unknown-role")).toBe(DEFAULT_PALETTE);
    expect(ROLE_PALETTES.boss?.shirt).toBeTruthy();
  });

  it("draws a frame with transparent corners and a solid body", () => {
    const buffer = drawFrame(DEFAULT_PALETTE, "down", "idle", 0);
    expect(buffer).toHaveLength(12 * 16 * 4);
    // Top-left corner stays transparent.
    expect(buffer[3]).toBe(0);
    // Some pixel is fully opaque.
    const opaque = Array.from({ length: 12 * 16 }, (_, index) => buffer[index * 4 + 3]);
    expect(opaque.filter((alpha) => alpha === 255).length).toBeGreaterThan(40);
  });

  it("produces different frames for different poses and facings", () => {
    const idle = drawFrame(DEFAULT_PALETTE, "down", "idle", 0);
    const typing = drawFrame(DEFAULT_PALETTE, "down", "type", 0);
    const up = drawFrame(DEFAULT_PALETTE, "up", "idle", 0);
    expect(Buffer.from(idle).equals(Buffer.from(typing))).toBe(false);
    expect(Buffer.from(idle).equals(Buffer.from(up))).toBe(false);
  });

  it("animates walking with two distinct steps", () => {
    const step0 = drawFrame(DEFAULT_PALETTE, "right", "walk", 0);
    const step1 = drawFrame(DEFAULT_PALETTE, "right", "walk", 1);
    expect(Buffer.from(step0).equals(Buffer.from(step1))).toBe(false);
  });
});

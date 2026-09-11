/**
 * The brand, drawn from a string — the one drawing three surfaces share.
 *
 * What is pinned here is what would break silently: a face with the wrong number of cells, a frame
 * that is the same picture as another frame (the header would never look busy), and the two shapes
 * the icons need — no plate, and a padded grid for the maskable icon.
 */
import { describe, expect, it } from "vitest";
import { BLINK, FRAMES, IDLE_00, MINI_NAME, THINK, idleBlink, idleDelayMs, pixelFaceSvg } from "../src/mini/brand.js";

describe("the pixel face", () => {
  it("is 8 rows of 8 in every frame", () => {
    for (const [name, cells] of Object.entries(FRAMES)) {
      expect(cells, name).toHaveLength(8);
      for (const row of cells) expect(row, name).toHaveLength(8);
    }
  });

  it("draws 64 cells plus a plate", () => {
    const svg = pixelFaceSvg({ size: 26 });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('width="26" height="26"');
    expect(svg).toContain('viewBox="0 0 8 8"');
    expect(svg.match(/<rect /g)).toHaveLength(65);
  });

  it("leaves the plate out when asked, for a face on a coloured button", () => {
    expect(pixelFaceSvg({ bg: "none" }).match(/<rect /g)).toHaveLength(64);
  });

  it("pads the grid for an icon that will be cropped to a circle", () => {
    expect(pixelFaceSvg({ pad: 2 })).toContain('viewBox="0 0 12 12"');
  });

  it("the three frames are three different pictures", () => {
    const [idle, blink, think] = (["idle", "blink", "think"] as const).map((frame) => pixelFaceSvg({ frame }));
    expect(new Set([idle, blink, think]).size).toBe(3);
    expect(IDLE_00).not.toEqual(BLINK);
    expect(IDLE_00).not.toEqual(THINK);
  });

  it("names the product the way a person reads it", () => {
    expect(MINI_NAME).toBe("00 Mini");
    expect(pixelFaceSvg()).toContain(`aria-label="${MINI_NAME}"`);
  });

  it("blinks mostly, and thinks occasionally", () => {
    expect(idleBlink(() => 0.1).frame).toBe("blink");
    expect(idleBlink(() => 0.9).frame).toBe("think");
    expect(idleDelayMs(() => 0)).toBe(2600);
    expect(idleDelayMs(() => 1)).toBe(6800);
  });
});

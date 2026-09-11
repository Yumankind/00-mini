/**
 * THE BRAND, AS A STRING — the 8×8 pixel face and the product's name (DESIGN.md, "Brand").
 *
 * WHY A STRING AND NOT A COMPONENT. Three surfaces draw this face: the floating widget (Vue), the
 * embed panel (no framework, inside a closed shadow root, on a byte budget) and the app's icons.
 * A Vue component serves exactly one of them, so the face lives here as markup any of the three can
 * paste — and this module imports NOTHING, which is what lets the 60 KB embed carry it.
 *
 * The cells are copied from the marketing site's own face (landing/components/PixelFace.vue): the
 * same three frames, so the logo on 0-0.chat and the logo in the widget are one drawing.
 */

/** What a person reads. The code names (`infinite`, `ia_` refs, `@00/agent-*`) do not change. */
export const MINI_NAME = "00 Mini";

/** 8 rows of 8 characters; `#` is a lit pixel. Verbatim from landing/components/PixelFace.vue. */
export const IDLE_00 = ["........", "..#..#..", ".#.##.#.", "........", "........", ".#....#.", "..####..", "........"];
export const BLINK = ["........", "........", ".##..##.", "........", "........", ".#....#.", "..####..", "........"];
export const THINK = ["........", "..#..#..", ".#.##.#.", "........", "........", "...##...", "...##...", "........"];

export type FaceFrame = "idle" | "blink" | "think";

export const FRAMES: Record<FaceFrame, string[]> = { idle: IDLE_00, blink: BLINK, think: THINK };

export interface FaceOptions {
  /** Rendered width and height in px. The grid itself is always 8×8 user units. */
  size?: number;
  /** The lit pixel. Mint by default — the one accent of the palette. */
  color?: string;
  /** The plate behind the pixels. `"none"` leaves it out, for a face on a coloured button. */
  bg?: string;
  /** Which of the three expressions. `think` is what the header wears while a run is in flight. */
  frame?: FaceFrame;
  /** The unlit pixel. Drawn rather than omitted, so the face reads as a screen and not as dots. */
  off?: string;
  /** Corner radius of the plate, in grid units (the icon wants a rounder one than the header). */
  radius?: number;
  /** Extra transparent margin in grid units, for a maskable icon that must survive a circle crop. */
  pad?: number;
}

/**
 * The face as one `<svg>` element, ready to set as `innerHTML`.
 *
 * Nothing here comes from a caller's free text: the only interpolated values are numbers and the
 * three colour strings, which are quoted attributes. It is safe to inject, and it is the only way
 * the embed can draw a logo without a second request.
 */
export function pixelFaceSvg(options: FaceOptions = {}): string {
  const size = options.size ?? 20;
  // White pixels, like the logo on 0-0.chat's header (Bruno, 2026-09-11) — mint is for status, not the mark.
  const color = options.color ?? "#eef1f3";
  const bg = options.bg ?? "#0f0f10";
  const off = options.off ?? "rgba(255,255,255,.10)";
  const pad = options.pad ?? 0;
  const radius = options.radius ?? 1.6;
  const span = 8 + pad * 2;
  const cells = FRAMES[options.frame ?? "idle"] ?? IDLE_00;

  const rects: string[] = [];
  if (bg !== "none") {
    rects.push(`<rect x="${pad}" y="${pad}" width="8" height="8" rx="${radius}" fill="${bg}" />`);
  }
  for (let r = 0; r < 8; r++) {
    const row = (cells[r] ?? "........").padEnd(8, ".");
    for (let c = 0; c < 8; c++) {
      const lit = row[c] === "#";
      rects.push(
        `<rect x="${pad + c + 0.1}" y="${pad + r + 0.1}" width="0.8" height="0.8" rx="0.2" fill="${lit ? color : off}" />`,
      );
    }
  }
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 ${span} ${span}" xmlns="http://www.w3.org/2000/svg" ` +
    `role="img" aria-label="${MINI_NAME}">${rects.join("")}</svg>`
  );
}

/**
 * The idle loop the logo runs: mostly a blink, occasionally a thought, then back to the face.
 *
 * Returned as a plan rather than performed, because the two implementations own their own timers
 * (Vue's `onUnmounted`, the panel's teardown) and because a pure sequence is testable.
 */
export function idleBlink(random = Math.random): { frame: FaceFrame; holdMs: number } {
  return random() < 0.8 ? { frame: "blink", holdMs: 130 } : { frame: "think", holdMs: 620 };
}

/** How long to wait before the next idle expression. Long enough not to be a distraction. */
export function idleDelayMs(random = Math.random): number {
  return 2600 + random() * 4200;
}

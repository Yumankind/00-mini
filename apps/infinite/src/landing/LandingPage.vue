<script setup lang="ts">
/**
 * THE LANDING PAGE, INSIDE THE PWA — which is what makes the widget over it a live agent and not a
 * screenshot (DESIGN.md, "The landing").
 *
 * WHY IT SCROLLS ITSELF. `src/style.css` locks `html, body, #app` to the viewport with
 * `overflow: hidden`, because the app is a shell whose inner regions scroll and an iOS home-screen
 * install must not rubber-band. A marketing page needs the opposite, and mutating the document's
 * overflow from a component would be one screen reaching into another's rules — so the page is its
 * own scroll container. The widget is `position: fixed`, so it follows the scroll either way, and a
 * fragment link still scrolls the nearest scrollable ancestor, which is this.
 *
 * The styles below are deliberately NOT scoped: the sections are separate components, and a scoped
 * rule would stop at this file's own markup. Every selector is prefixed `landing-` instead.
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import LandingHeader from "./LandingHeader.vue";
import HeroSection from "./HeroSection.vue";
import CodeSection from "./CodeSection.vue";
import CarrySection from "./CarrySection.vue";
import TrustSection from "./TrustSection.vue";
import BrainsSection from "./BrainsSection.vue";
import EmbedSection from "./EmbedSection.vue";
import FaqSection from "./FaqSection.vue";
import LandingFooter from "./LandingFooter.vue";

const root = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;
let stopCatchUp: (() => void) | null = null;

onMounted(() => {
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const targets = [...(root.value?.querySelectorAll("[data-reveal]") ?? [])];
  // Reduced motion, or a browser with no observer: everything is simply already there.
  if (reduced || typeof IntersectionObserver === "undefined") {
    for (const el of targets) el.classList.add("is-in");
    return;
  }
  const reveal = (el: Element): void => {
    el.classList.add("is-in");
    observer?.unobserve(el);
  };
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        // Intersecting, or already gone past the top edge — the second half is what an anchor
        // landing does: `/#embed` puts half the page above the fold, and an element that was never
        // on screen never gets a second callback. Invisible for ever is a worse animation than none.
        if (entry.isIntersecting || entry.boundingClientRect.top < 0) reveal(entry.target);
      }
    },
    { rootMargin: "0px 0px -10% 0px", threshold: 0.05 },
  );
  for (const el of targets) observer.observe(el);

  /**
   * The catch-up, for the one case the observer cannot see: a JUMP — the agent scrolling the page
   * to a section, a fragment link — moves the viewport past elements without ever intersecting
   * them. This sweeps whatever the jump skipped, once per frame at most, and takes itself off the
   * moment everything has been revealed.
   */
  const scroller = root.value;
  if (!scroller) return;
  let queued = false;
  const sweep = (): void => {
    queued = false;
    const left = targets.filter((el) => !el.classList.contains("is-in"));
    for (const el of left) {
      if (el.getBoundingClientRect().top < window.innerHeight) reveal(el);
    }
    if (left.length === 0) stopCatchUp?.();
  };
  const onScroll = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(sweep);
  };
  scroller.addEventListener("scroll", onScroll, { passive: true });
  stopCatchUp = () => {
    scroller.removeEventListener("scroll", onScroll);
    stopCatchUp = null;
  };
});

onBeforeUnmount(() => {
  observer?.disconnect();
  stopCatchUp?.();
});
</script>

<template>
  <div ref="root" class="landing">
    <LandingHeader />
    <main class="landing-inner">
      <HeroSection />
      <CodeSection />
      <CarrySection />
      <TrustSection />
      <BrainsSection />
      <EmbedSection />
      <FaqSection />
    </main>
    <LandingFooter />
  </div>
</template>

<style>
.landing {
  height: 100%;
  overflow-y: auto;
  overscroll-behavior-y: contain;
  scroll-behavior: smooth;
  scroll-padding-top: 72px;
  background: var(--color-void);
  color: var(--color-ink);
  font-family: var(--font-sans);
}
@media (prefers-reduced-motion: reduce) {
  .landing {
    scroll-behavior: auto;
  }
}

.landing-inner {
  width: 100%;
  max-width: 68rem;
  margin: 0 auto;
  padding: 0 20px;
}
@media (min-width: 640px) {
  .landing-inner {
    padding: 0 32px;
  }
}

.landing-header {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 56px;
  padding: 0 20px;
  border-bottom: 1px solid transparent;
  background: color-mix(in srgb, var(--color-void) 82%, transparent);
  backdrop-filter: blur(12px);
}
@media (min-width: 640px) {
  .landing-header {
    padding: 0 32px;
  }
}
.landing-header a {
  color: inherit;
}
.landing-logo svg {
  display: block;
  border-radius: 6px;
}
.landing-face svg {
  display: block;
  border-radius: 12px;
}

/* ── the two controls ──────────────────────────────────────────────────────────────────────────
   Primary is ink on void — black on white, white on black — never the accent. The accent is for
   the face, the status dots, progress and links (DESIGN.md, "Tokens"). */
.landing-cta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  border-radius: 10px;
  padding: 7px 14px;
  cursor: pointer;
  background: var(--color-ink);
  color: var(--color-void);
  font: 600 12.5px/1.2 var(--font-sans);
  transition: opacity 0.16s ease-out;
}
.landing-cta:hover {
  opacity: 0.86;
}
.landing-cta-lg {
  padding: 11px 20px;
  font-size: 14px;
  border-radius: 12px;
}
.landing-ghost {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--color-line);
  border-radius: 10px;
  padding: 7px 14px;
  color: var(--color-ink);
  text-decoration: none;
  font: 500 12.5px/1.2 var(--font-sans);
  transition:
    border-color 0.16s ease-out,
    background-color 0.16s ease-out;
}
.landing-ghost:hover {
  border-color: color-mix(in srgb, var(--color-phosphor) 55%, transparent);
  background: color-mix(in srgb, var(--color-panel) 60%, transparent);
}
.landing-ghost-lg {
  padding: 11px 20px;
  font-size: 14px;
  border-radius: 12px;
}
.landing :focus {
  outline: none;
}
.landing :focus-visible {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-ink) 18%, transparent);
}

/* ── rhythm ───────────────────────────────────────────────────────────────────────────────────── */
.landing-section {
  padding: 72px 0;
  scroll-margin-top: 72px;
}
@media (min-width: 640px) {
  .landing-section {
    padding: 104px 0;
  }
}
.landing-eyebrow {
  margin: 0;
  font: 500 11px/1.4 var(--font-mono);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--color-phosphor);
}
.landing-h2 {
  margin: 14px 0 0;
  font-size: 24px;
  line-height: 1.2;
  font-weight: 600;
  letter-spacing: -0.02em;
  max-width: 34rem;
}
@media (min-width: 640px) {
  .landing-h2 {
    font-size: 32px;
  }
}
.landing-lead {
  margin: 16px 0 0;
  max-width: 40rem;
  font-size: 14.5px;
  line-height: 1.65;
  color: var(--color-ink-dim);
}
.landing-muted {
  color: var(--color-ink-dim);
}
.landing-foot {
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-ink-faint, var(--color-ink-dim));
}
.landing-foot a,
.landing-link {
  color: var(--color-phosphor);
  text-decoration: none;
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
  font: inherit;
}
.landing-foot a:hover,
.landing-link:hover {
  text-decoration: underline;
}
.landing code {
  font-family: var(--font-mono);
  font-size: 0.92em;
  color: var(--color-ink);
}

.landing-card {
  border: 1px solid var(--color-line);
  border-radius: 14px;
  background: color-mix(in srgb, var(--color-card) 70%, transparent);
  padding: 18px;
  transition: border-color 0.16s ease-out;
}
.landing-card:hover {
  border-color: color-mix(in srgb, var(--color-phosphor) 35%, transparent);
}
.landing-card h3 {
  margin: 0;
}
.landing-card p {
  margin: 6px 0 0;
}

.landing-tick {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--color-ink-dim);
}
.landing-tick svg {
  margin-top: 3px;
  flex: none;
  color: var(--color-phosphor);
}
.landing-tick-amber svg {
  color: var(--color-amber);
}

.landing-pointer {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 12.5px;
  color: var(--color-ink-dim);
}
.landing-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-phosphor);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-phosphor) 18%, transparent);
}

/* ── the model table ──────────────────────────────────────────────────────────────────────────── */
.landing-table-wrap {
  border: 1px solid var(--color-line);
  border-radius: 14px;
  overflow: hidden;
}
.landing-table {
  width: 100%;
  min-width: 34rem;
  border-collapse: collapse;
  font-size: 13px;
}
.landing-table-wrap {
  overflow-x: auto;
}
.landing-table th {
  text-align: left;
  padding: 11px 16px;
  font: 400 10.5px/1.4 var(--font-mono);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--color-ink-dim);
  border-bottom: 1px solid var(--color-line);
}
.landing-table td {
  padding: 11px 16px;
  border-bottom: 1px solid color-mix(in srgb, var(--color-line) 55%, transparent);
}
.landing-table tr:last-child td {
  border-bottom: 0;
}
.landing-tag {
  margin-left: 7px;
  border: 1px solid color-mix(in srgb, var(--color-cyan) 35%, transparent);
  border-radius: 5px;
  padding: 1px 5px;
  font: 400 10px/1.4 var(--font-mono);
  color: var(--color-cyan);
  vertical-align: middle;
}

/* ── the snippet ──────────────────────────────────────────────────────────────────────────────── */
.landing-code {
  border: 1px solid var(--color-line);
  border-radius: 14px;
  overflow: hidden;
  background: color-mix(in srgb, var(--color-card) 80%, transparent);
  max-width: 44rem;
}
.landing-code-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--color-line);
}
.landing-copy {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--color-line);
  border-radius: 8px;
  padding: 3px 8px;
  background: transparent;
  color: var(--color-ink-dim);
  cursor: pointer;
  font: 500 11px/1.4 var(--font-mono);
}
.landing-copy:hover {
  color: var(--color-phosphor);
  border-color: color-mix(in srgb, var(--color-phosphor) 45%, transparent);
}
.landing-pre {
  margin: 0;
  padding: 14px 12px;
  overflow-x: auto;
  font: 400 12.5px/1.5 var(--font-mono);
  color: var(--color-phosphor);
}

/* ── the footer ───────────────────────────────────────────────────────────────────────────────── */
.landing-footer {
  border-top: 1px solid var(--color-line);
  padding: 28px 0 96px;
  color: var(--color-ink-dim);
}

/* ── reveal ───────────────────────────────────────────────────────────────────────────────────── */
[data-reveal] {
  opacity: 0;
  transform: translateY(10px);
  transition:
    opacity 0.4s ease-out,
    transform 0.4s ease-out;
}
[data-reveal].is-in {
  opacity: 1;
  transform: none;
}
@media (prefers-reduced-motion: reduce) {
  [data-reveal] {
    opacity: 1;
    transform: none;
    transition: none;
  }
}
</style>

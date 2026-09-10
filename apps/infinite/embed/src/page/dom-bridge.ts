/**
 * The browser half of the PageBridge: reading the host page and pointing at things in it.
 *
 * WHY it draws its own overlay rather than restyling the page: touching a host page's styles is a
 * modification, and §13 forbids modifying. The outline and the callout are absolutely-positioned
 * elements the embed owns, inside its own container, removed on the next message or the next click.
 * The host page's DOM is read; it is never written to.
 */

import type { AuthState } from "../types.js";
import type { AxNode, CurrentPage, PageBridge } from "./bridge.js";

/** Roles worth putting in the tree: what a person can read as structure or operate as a control. */
const AX_SELECTOR =
  "h1,h2,h3,h4,h5,h6,a[href],button,[role=button],input:not([type=hidden]),select,textarea,summary," +
  "[role=link],[role=menuitem],[role=tab],[role=search],nav,main,form,label";

export interface DomBridgeOptions {
  origin: string;
  authState: () => AuthState;
  /** Called before a navigation so the panel can park its state (§5.2.2, `page_open`). */
  beforeOpen?: (url: string) => void;
}

export function createDomBridge(opts: DomBridgeOptions): PageBridge {
  const refs = new Map<string, Element>();
  let counter = 0;
  let layer: HTMLElement | null = null;

  const ensureLayer = (): HTMLElement => {
    if (layer?.isConnected) return layer;
    layer = document.createElement("div");
    layer.setAttribute("data-infinite-agent", "highlight");
    Object.assign(layer.style, {
      position: "fixed",
      inset: "0",
      pointerEvents: "none",
      zIndex: "2147483645",
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(layer);
    return layer;
  };

  const resolve = (target: string): Element | null => {
    if (refs.has(target)) return refs.get(target) ?? null;
    try {
      return document.querySelector(target);
    } catch {
      return null;
    }
  };

  const name = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria?.trim()) return aria.trim();
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text) return text.slice(0, 120);
    return (
      el.getAttribute("placeholder")?.trim() ||
      el.getAttribute("title")?.trim() ||
      el.getAttribute("value")?.trim() ||
      ""
    );
  };

  const role = (el: Element): string => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "a") return "link";
    if (tag === "input") return (el.getAttribute("type") ?? "text") === "submit" ? "button" : "textbox";
    return tag;
  };

  return {
    current(): CurrentPage {
      refs.clear();
      counter = 0;
      const tree: AxNode[] = [];
      for (const el of document.querySelectorAll(AX_SELECTOR)) {
        // The embed's own shadow host is not part of the page it is describing.
        if (el.closest("[data-infinite-agent]")) continue;
        const label = name(el);
        const r = role(el);
        if (!label && r !== "form" && r !== "nav" && r !== "main") continue;
        const ref = `e${++counter}`;
        refs.set(ref, el);
        const node: AxNode = { ref, role: r, name: label };
        if (r === "heading") node.level = Number(el.tagName.slice(1)) || undefined;
        const href = el.getAttribute("href");
        if (href) {
          try {
            const abs = new URL(href, location.href);
            if (abs.origin === opts.origin) node.href = abs.pathname + abs.search;
          } catch {
            /* not a URL we can offer */
          }
        }
        tree.push(node);
        if (tree.length >= 200) break;
      }
      const height = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      return {
        url: location.href,
        title: document.title,
        tree,
        scroll: {
          y: Math.round(window.scrollY),
          height: document.documentElement.scrollHeight,
          percent: Math.round((window.scrollY / height) * 100),
        },
        authState: opts.authState(),
      };
    },

    open(url: string): { ok: boolean; message: string } {
      let abs: URL;
      try {
        abs = new URL(url, location.href);
      } catch {
        return { ok: false, message: `${url} is not a URL` };
      }
      // Same origin only. This is the one place the embed changes what the visitor is looking at,
      // and it may only ever move them within the site the snippet is on.
      if (abs.origin !== opts.origin) return { ok: false, message: `${abs.origin} is not this site` };
      opts.beforeOpen?.(abs.toString());
      location.assign(abs.toString());
      return { ok: true, message: `opening ${abs.pathname}` };
    },

    scrollTo(target: string): boolean {
      const el = resolve(target);
      if (!el) return false;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      return true;
    },

    highlight(target: string, note?: string): boolean {
      const el = resolve(target);
      if (!el) return false;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const box = el.getBoundingClientRect();
      const host = ensureLayer();
      host.replaceChildren();

      const ring = document.createElement("div");
      Object.assign(ring.style, {
        position: "absolute",
        left: `${box.left - 4}px`,
        top: `${box.top - 4}px`,
        width: `${box.width + 8}px`,
        height: `${box.height + 8}px`,
        border: "2px solid #ffbb22",
        borderRadius: "8px",
        boxShadow: "0 0 0 9999px rgba(0,0,0,.18)",
        transition: "opacity .2s",
      } satisfies Partial<CSSStyleDeclaration>);
      host.appendChild(ring);

      if (note) {
        const callout = document.createElement("div");
        callout.textContent = note.slice(0, 140);
        Object.assign(callout.style, {
          position: "absolute",
          left: `${Math.max(8, box.left - 4)}px`,
          top: `${Math.max(8, box.top - 40)}px`,
          maxWidth: "260px",
          padding: "6px 10px",
          borderRadius: "8px",
          background: "#111",
          color: "#fff",
          font: "500 13px/1.35 system-ui,-apple-system,sans-serif",
        } satisfies Partial<CSSStyleDeclaration>);
        host.appendChild(callout);
      }
      return true;
    },

    describe(target: string): string | null {
      const el = resolve(target);
      if (!el) return null;
      const r = role(el);
      const label = name(el) || "(no accessible name)";
      const where: string[] = [];
      for (let p = el.parentElement, hops = 0; p && hops < 6; p = p.parentElement, hops++) {
        const tag = p.tagName.toLowerCase();
        if (["nav", "header", "footer", "main", "aside", "form", "section"].includes(tag)) {
          where.push(p.getAttribute("aria-label") ? `${tag} "${p.getAttribute("aria-label")}"` : tag);
        }
      }
      const href = el.getAttribute("href");
      const disabled = el.hasAttribute("disabled") ? ", currently disabled" : "";
      const box = el.getBoundingClientRect();
      const visible = box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < window.innerHeight;
      return [
        `${r} "${label}"${disabled}`,
        href ? `goes to ${href}` : null,
        where.length ? `inside ${where.join(" › ")}` : null,
        visible ? "on screen now" : "off screen; it needs scrolling to",
      ]
        .filter(Boolean)
        .join("; ");
    },

    clearHighlights(): void {
      layer?.replaceChildren();
    },
  };
}

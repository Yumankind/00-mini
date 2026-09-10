/**
 * THE INSPECTOR, served at `/__inspector.js`.
 *
 * ⚠️ THIS TEXT IS A COPY. It is authored in `apps/infinite/src/lib/pick.ts` as `INSPECTOR_SOURCE`,
 * because the SAME script has to run in two places the other cannot reach: inside a page served from
 * this origin (the live road), and inside the app's own opaque `srcdoc` snapshot frame (the fallback,
 * which works before this host is deployed at all). This Worker is outside the pnpm workspace and has
 * no node_modules, so it cannot import that module — it carries the bytes instead, and
 * `apps/infinite/test/preview-live.test.ts` compares the two files and fails the day they differ.
 *
 * To change the inspector: edit `apps/infinite/src/lib/pick.ts` and copy the new text here verbatim.
 * No backtick and no ${ may appear inside — both files hold it in a `String.raw`.
 */
export const INSPECTOR_SOURCE = String.raw`/* 00 preview inspector — see apps/infinite/src/lib/pick.ts for why this text exists twice. */
(function () {
  "use strict";

  var V = 1;
  var MAX_HTML = 2048;
  var MAX_TEXT = 200;
  var MAX_DEPTH = 5;
  var RING_ID = "__00_inspect_ring";

  // ---------- pure: a chain of element descriptions -> one CSS selector ----------

  // Classes a bundler generated are not classes a person can point at tomorrow. Anything that looks
  // like a hash, a CSS-module suffix or a framework scope is dropped from the selector; the element
  // still gets found by tag and position, which is at least honest about being positional.
  var SCOPED = /^(?:svelte|css|sc|jsx|emotion|tw|module)[-_][A-Za-z0-9]{4,}$/;
  var HASHY = /^[A-Za-z_-]*[0-9a-f]{6,}$/;

  function stableClass(name) {
    if (!name || name.length > 40) return false;
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) return false;
    if (SCOPED.test(name)) return false;
    if (HASHY.test(name)) return false;
    return true;
  }

  function signatureOf(classes) {
    var out = [];
    for (var i = 0; i < classes.length; i++) {
      if (stableClass(classes[i]) && out.length < 2) out.push(classes[i]);
    }
    return out;
  }

  // chain[0] is the element, chain[n] its ancestors. Each entry says what makes it findable:
  // a document-unique id, the classes worth keeping, its nth-of-type index, and whether tag +
  // classes already tell it apart from its same-tag siblings.
  function selectorFromChain(chain) {
    var parts = [];
    for (var i = 0; i < chain.length && i < MAX_DEPTH; i++) {
      var node = chain[i];
      if (node.id && node.idUnique) {
        parts.unshift("#" + node.id);
        break;
      }
      var part = node.tag;
      var classes = signatureOf(node.classes || []);
      for (var c = 0; c < classes.length; c++) part += "." + classes[c];
      if (!node.uniqueAmongSiblings) part += ":nth-of-type(" + node.nth + ")";
      parts.unshift(part);
      if (node.tag === "body") break;
    }
    return parts.join(" > ") || "html";
  }

  function trimText(raw) {
    var one = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
    return one.length > MAX_TEXT ? one.slice(0, MAX_TEXT - 1) + "…" : one;
  }

  function trimHtml(raw) {
    var text = String(raw == null ? "" : raw);
    if (text.length <= MAX_HTML) return text;
    return text.slice(0, MAX_HTML) + "\n<!-- trimmed at " + MAX_HTML + " characters -->";
  }

  var ROLES = {
    a: "link", button: "button", h1: "heading", h2: "heading", h3: "heading", h4: "heading",
    h5: "heading", h6: "heading", img: "img", nav: "navigation", main: "main", form: "form",
    ul: "list", ol: "list", li: "listitem", table: "table", select: "combobox", textarea: "textbox",
    header: "banner", footer: "contentinfo", aside: "complementary", section: "region", p: "paragraph"
  };

  function roleFor(tag, type, explicit) {
    if (explicit) return explicit;
    if (tag === "input") {
      if (type === "submit" || type === "button" || type === "reset") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "textbox";
    }
    return ROLES[tag] || tag;
  }

  var api = {
    selectorFromChain: selectorFromChain,
    stableClass: stableClass,
    trimText: trimText,
    trimHtml: trimHtml,
    roleFor: roleFor
  };
  if (typeof globalThis !== "undefined") globalThis.__00_inspector = api;

  // ---------- everything below needs a document ----------

  if (typeof document === "undefined" || typeof window === "undefined") return;
  if (window.parent === window) return; // opened in a tab: there is nobody to tell

  var inspecting = false;
  var hovered = null;

  function meta(name) {
    var el = document.querySelector('meta[name="' + name + '"]');
    return el ? el.getAttribute("content") : null;
  }

  // The parent's origin, announced rather than guessed. On the live road this page and the host page
  // share an origin, so location.origin is exactly right; in the snapshot frame the origin is opaque
  // (the literal string "null") and the app stamps the meta instead.
  function target() {
    var announced = meta("00-target");
    if (announced) return announced;
    if (location.origin && location.origin !== "null") return location.origin;
    return "*";
  }

  function post(data) {
    try {
      window.parent.postMessage(data, target());
    } catch (err) {
      /* a parent that went away is not something a preview can fix */
    }
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/[^A-Za-z0-9_-]/g, "\\$&");
  }

  function classesOf(el) {
    var raw = (el.getAttribute("class") || "").split(/\s+/);
    var out = [];
    for (var i = 0; i < raw.length; i++) if (raw[i]) out.push(raw[i]);
    return out;
  }

  function chainFor(el) {
    var chain = [];
    var node = el;
    while (node && node.nodeType === 1 && chain.length < 12) {
      var tag = node.tagName.toLowerCase();
      if (tag === "html") break;
      var parent = node.parentElement;
      var sameTag = [];
      if (parent) {
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].tagName === node.tagName) sameTag.push(parent.children[i]);
        }
      }
      var classes = classesOf(node);
      var mine = signatureOf(classes).join(".");
      var twins = 0;
      for (var s = 0; s < sameTag.length; s++) {
        if (signatureOf(classesOf(sameTag[s])).join(".") === mine) twins++;
      }
      var id = node.getAttribute("id");
      var idUsable = !!id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(id);
      chain.push({
        tag: tag,
        id: idUsable ? id : null,
        idUnique: idUsable && document.querySelectorAll("#" + cssEscape(id)).length === 1,
        classes: classes,
        nth: sameTag.indexOf(node) + 1,
        uniqueAmongSiblings: sameTag.length === 1 || (mine !== "" && twins === 1)
      });
      node = parent;
    }
    return chain;
  }

  function nameFor(el) {
    var aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return trimText(aria);
    var by = el.getAttribute("aria-labelledby");
    if (by) {
      var labelled = document.getElementById(by.split(/\s+/)[0]);
      if (labelled) return trimText(labelled.textContent);
    }
    var tag = el.tagName.toLowerCase();
    if (tag === "img") return trimText(el.getAttribute("alt") || "");
    if (tag === "input" || tag === "select" || tag === "textarea") {
      var id = el.getAttribute("id");
      if (id) {
        var label = document.querySelector('label[for="' + cssEscape(id) + '"]');
        if (label) return trimText(label.textContent);
      }
      return trimText(el.getAttribute("placeholder") || el.getAttribute("value") || "");
    }
    var text = trimText(el.textContent);
    if (text) return text;
    return trimText(el.getAttribute("title") || el.getAttribute("placeholder") || "");
  }

  var STYLE_KEYS = ["color", "backgroundColor", "font", "fontSize", "margin", "padding", "display"];

  function describe(el) {
    var box = el.getBoundingClientRect();
    var computed = window.getComputedStyle(el);
    var styles = {};
    for (var i = 0; i < STYLE_KEYS.length; i++) {
      var key = STYLE_KEYS[i];
      var value = computed[key];
      if (value) styles[key] = String(value);
    }
    var tag = el.tagName.toLowerCase();
    return {
      kind: "00-pick",
      v: V,
      selector: selectorFromChain(chainFor(el)),
      tag: tag,
      role: roleFor(tag, el.getAttribute("type"), el.getAttribute("role")),
      name: nameFor(el),
      text: trimText(el.textContent),
      html: trimHtml(el.outerHTML),
      box: {
        x: Math.round(box.left + window.scrollX),
        y: Math.round(box.top + window.scrollY),
        width: Math.round(box.width),
        height: Math.round(box.height)
      },
      styles: styles,
      url: location.href,
      source: meta("00-source")
    };
  }

  // The ring is the inspector's OWN element, positioned over the page — the host page's styles are
  // never touched, the same rule the embed's dom-bridge follows. It is skipped by every hit test.
  function ring() {
    var el = document.getElementById(RING_ID);
    if (el) return el;
    el = document.createElement("div");
    el.id = RING_ID;
    el.setAttribute("data-00-inspector", "");
    el.style.cssText =
      "position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #22d3ee;" +
      "border-radius:4px;background:rgba(34,211,238,.10);transition:all .06s linear;display:none";
    (document.body || document.documentElement).appendChild(el);
    return el;
  }

  function outline(el) {
    var host = ring();
    if (!el) {
      host.style.display = "none";
      return;
    }
    var box = el.getBoundingClientRect();
    host.style.display = "block";
    host.style.left = box.left - 2 + "px";
    host.style.top = box.top - 2 + "px";
    host.style.width = box.width + "px";
    host.style.height = box.height + "px";
  }

  function candidate(event) {
    var el = event.target;
    if (!el || el.nodeType !== 1) return null;
    if (el.id === RING_ID || el.hasAttribute("data-00-inspector")) return null;
    return el;
  }

  function armed(event) {
    return inspecting || event.altKey;
  }

  document.addEventListener(
    "mousemove",
    function (event) {
      if (!armed(event)) {
        if (hovered) {
          hovered = null;
          outline(null);
        }
        return;
      }
      var el = candidate(event);
      if (el === hovered) return;
      hovered = el;
      outline(el);
    },
    true
  );

  document.addEventListener(
    "click",
    function (event) {
      if (!armed(event)) return;
      var el = candidate(event);
      if (!el) return;
      // A picked link must not also navigate, and a picked submit must not also submit: pointing at
      // a thing is not operating it.
      event.preventDefault();
      event.stopPropagation();
      outline(el);
      post(describe(el));
    },
    true
  );

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    hovered = null;
    outline(null);
    post({ kind: "00-pick-clear", v: V });
  });

  window.addEventListener("scroll", function () {
    if (hovered) outline(hovered);
  }, true);

  // The parent turns inspect mode on and off; every other message is somebody else's.
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.kind !== "00-inspect") return;
    inspecting = !!data.on;
    if (!inspecting) {
      hovered = null;
      outline(null);
    }
  });

  post({ kind: "00-nav", v: V, url: location.href, title: document.title, source: meta("00-source") });
})();
`;

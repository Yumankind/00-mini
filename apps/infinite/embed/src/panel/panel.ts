/**
 * The panel: a chat when there is a brain, a site search when there is not (§5.2.3).
 *
 * WHY the no-brain path is the DEFAULT path and not a degraded one: level 0 ships with no model,
 * and a visitor who opens the panel must get an answer in the same second. So the search path is
 * written first and fully — hits are clickable, "where is X" points at the thing — and a brain,
 * when one exists, simply takes over the same transcript and the same tools.
 *
 * Everything is built inside the CLOSED shadow root the loader made. The panel never writes to the
 * host page; the only marks it leaves outside itself are the highlight overlay (which it owns and
 * clears) and a navigation the visitor asked for.
 */

import type { Tool } from "@00/agent-runtime";
import { threadFs, type Brain } from "../brain.js";
import type { AgentEvent } from "@00/agent-runtime";
import type { Carrier, SiteConfig } from "../site-config.js";
import type { SiteIndex } from "../index/site-index.js";
import { pathOf } from "../index/site-index.js";
import type { PageBridge } from "../page/bridge.js";
import { matchLandmark, planNoBrainReply } from "./no-brain.js";
import { renderSetup, type AdminFlow, type SetupHandle } from "./setup.js";
import { PANEL_CSS } from "./styles.js";
import { CRAWL_BAR_LINGER_MS, crawlBarState } from "./crawl-progress.js";
import type { CrawlProgress } from "../crawl/crawler.js";
import { MINI_NAME, pixelFaceSvg } from "../../../src/mini/brand.js";
import { renderMarkdown } from "../../../src/lib/markdown-lite.js";

export interface PanelDeps {
  shadow: ShadowRoot;
  origin: string;
  ref: string;
  productHost: string;
  config: SiteConfig;
  carrier: Carrier;
  /** Owner-facing notes: a rejected site file, a clamped field (§5.2.4). */
  notes: string[];
  index: SiteIndex;
  page: PageBridge;
  tools: Tool[];
  brain: Brain | null;
  /** The download the visitor is OFFERED, never given automatically (§5.2.3). */
  localAi: {
    sizeMb: number;
    /** The model's name and its publisher's licence — shown beside the button, before any download. */
    model: { name: string; licenseName: string; licenseUrl: string; useRestrictionsUrl?: string };
    /** Something to know before pressing — today, "this browser has no WebGPU". */
    note?: string;
    /**
     * Returns the brain AND the model that actually loaded: the pair of local providers falls
     * through (LiteRT, then web-llm), so the row named on the button is a prediction and this is
     * the fact. The panel relabels itself from it.
     */
    load: (onProgress: (line: string) => void) => Promise<{ brain: Brain; model: { name: string } } | null>;
  };
  clearMemory: () => Promise<void>;
  applyConfig: (config: SiteConfig) => void;
  fetchImpl: typeof fetch;
  /** True when this site has no site.json yet: the gear opens the owner's setup flow. */
  needsSetup: boolean;
  /**
   * Phase 3 (§5.6): the panel tells the loader when it is open, and the reply poller runs then and
   * only then. A closed panel has nowhere to put a reply, and a site with a thousand readers and no
   * open panels must make no calls at all.
   */
  onOpenChange?: (open: boolean) => void;
  /** Phase 3 (§5.3, §5.4): what the admin flow's Register card needs. Absent ⇒ the card is not shown. */
  admin?: AdminFlow;
}

export interface PanelHandle {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  onAgentEvent(event: AgentEvent): void;
  /**
   * The `confirm` tier, rendered (§5.2.2). Resolves true only when the visitor presses the button
   * with the question's own words above it — never on a timeout, never by default.
   */
  confirm(question: string, detail?: string): Promise<boolean>;
  /** A reply the owner sent, shown as what it is: a person, not the agent (§5.6). */
  ownerMessage(text: string): void;
  /**
   * The crawl's count, drawn as a slim bar under the header while the loader reads the site
   * (Bruno, 2026-09-11). The finished bar lingers for a moment with "Read N pages", then goes.
   */
  crawlProgress(progress: CrawlProgress): void;
}

/** Survives a `page_open` navigation: the panel reopens where it was (§5.2.2). */
interface ParkedState {
  open: boolean;
  transcript: { who: "me" | "them" | "status"; text: string }[];
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of children) node.append(c);
  return node;
};

export function stateKey(ref: string): string {
  return `infinite-agent:${ref}`;
}

export function readParked(ref: string): ParkedState | null {
  try {
    const raw = sessionStorage.getItem(stateKey(ref));
    return raw ? (JSON.parse(raw) as ParkedState) : null;
  } catch {
    return null;
  }
}

export function park(ref: string, state: ParkedState): void {
  try {
    // sessionStorage, not localStorage: the panel's transcript is this tab's business and dies
    // with it. Nothing about a conversation outlives the visit.
    sessionStorage.setItem(stateKey(ref), JSON.stringify(state));
  } catch {
    /* storage refused; the panel simply starts fresh after a navigation */
  }
}

export function createPanel(deps: PanelDeps): PanelHandle {
  const transcript: ParkedState["transcript"] = [];
  let brain = deps.brain;
  let open = false;
  let busy = false;
  /** The bubble the runtime's `agent_message` events stream into, while a turn is in flight. */
  let live: HTMLElement | null = null;

  deps.shadow.append(el("style", { textContent: PANEL_CSS }));
  const wrap = el("div", { className: "mini" });
  const panel = el("div", { className: "mini-panel" });
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", deps.config.intro.name || MINI_NAME);

  const body = el("div", { className: "mini-body" });
  const input = el("input", { type: "text", className: "mini-input", placeholder: brain ? "Ask about this site" : "Search this site" });
  input.setAttribute("aria-label", "Ask about this site");
  const form = el("form", { className: "mini-composer" }, [
    input,
    el("button", { className: "mini-send", type: "submit", textContent: "↑", title: "Ask" }),
  ]);

  /** The face, drawn from the same cells as the app's logo — and it thinks while a turn is in flight. */
  const faceHost = el("div", { className: "mini-face" });
  const drawFace = (thinking: boolean): void => {
    faceHost.innerHTML = pixelFaceSvg({ size: 26, frame: thinking ? "think" : "idle" });
  };
  drawFace(false);

  const title = el("div", { className: "mini-heading" }, [
    el("div", { className: "mini-title", textContent: deps.config.intro.name || MINI_NAME }),
    el("div", { className: "mini-sub", textContent: deps.config.intro.line || `${deps.index.size()} pages known` }),
  ]);
  const gear = el("button", { className: "mini-icon", type: "button", textContent: "⚙", title: "Owner setup" });
  const close = el("button", { className: "mini-icon", type: "button", textContent: "✕", title: "Close" });
  // The expand button belongs to the app's own widget; on somebody else's site there is nothing to
  // expand into, so it is absent rather than disabled (DESIGN.md: "the embed hides it").
  const header = el("div", { className: "mini-header" }, [faceHost, title, el("div", { className: "mini-actions" }, [gear, close])]);

  const clear = el("button", { type: "button", textContent: "Clear memory" });
  const sponsor = el("div", { className: "mini-sponsor" });
  const footer = el("div", { className: "mini-footer" }, [clear, el("span", { textContent: "· on your device only" }), sponsor]);

  /** The reading, made visible: a line and a bar, hidden when nothing is being read. */
  const crawlLine = el("span", { className: "mini-crawl-line" });
  const crawlFill = el("span", { className: "mini-crawl-fill" });
  const crawl = el("div", { className: "mini-crawl" }, [crawlLine, el("span", { className: "mini-crawl-bar" }, [crawlFill])]);
  crawl.hidden = true;
  crawl.setAttribute("role", "status");
  let crawlHide: ReturnType<typeof setTimeout> | undefined;
  const crawlProgress = (progress: CrawlProgress): void => {
    const state = crawlBarState(progress);
    if (crawlHide) clearTimeout(crawlHide);
    crawl.hidden = !state.visible;
    crawlLine.textContent = state.line;
    crawlFill.style.width = `${state.percent}%`;
    crawl.toggleAttribute("data-done", state.finished);
    launcher.toggleAttribute("data-busy", state.visible && !state.finished);
    if (state.finished) {
      crawlHide = setTimeout(() => {
        crawl.hidden = true;
        // The subline counts pages when the owner gave it no line of their own; once a round has
        // landed it says the new number rather than the one from before the reading.
        const sub = title.querySelector(".mini-sub");
        if (sub && (!deps.config.intro.line || /pages known$/.test(sub.textContent ?? ""))) {
          sub.textContent = `${deps.index.size()} pages known`;
        }
      }, CRAWL_BAR_LINGER_MS);
    }
  };

  panel.append(header, crawl, body, form, footer);
  const launcher = el("button", { className: "mini-launcher", type: "button" }, [
    el("span", { className: "mini-face", innerHTML: pixelFaceSvg({ size: 22 }) }),
    el("span", { textContent: deps.config.intro.name || MINI_NAME }),
  ]);
  wrap.append(panel, launcher);
  deps.shadow.append(wrap);

  // ── transcript ─────────────────────────────────────────────────────────────────────────────
  /**
   * AN AGENT'S ANSWER IS MARKDOWN, and it is rendered — the same renderer the full app uses
   * (`src/lib/markdown-lite.ts`), which escapes every character of the input BEFORE any markup is
   * added and allowlists a link's scheme. That is what makes it safe to put a model's words into a
   * panel that is sitting on somebody else's website: nothing the model writes can become markup it
   * did not build itself, and raw HTML in the source stays visible as text.
   *
   * The person's own line and a status line are plain text, and stay plain text.
   */
  const setText = (node: HTMLElement, text: string): void => {
    const md = node.querySelector(".mini-md");
    if (md) md.innerHTML = renderMarkdown(text);
    else node.textContent = text;
  };
  /** What is in a row, without asking the DOM to un-render it (the markdown is one-way). */
  const textOf = new WeakMap<HTMLElement, string>();

  const say = (who: "me" | "them" | "status", text: string, remember = true): HTMLElement => {
    const kind = who === "me" ? "me" : who === "status" ? "status" : "them";
    const node = el("div", { className: `mini-row ${kind}` });
    if (kind === "them") node.append(el("div", { className: "mini-md" }));
    setText(node, text);
    textOf.set(node, text);
    body.append(node);
    body.scrollTop = body.scrollHeight;
    if (remember) transcript.push({ who, text });
    return node;
  };

  /** Replace a row's words — the one path that keeps the rendered markup and the remembered text in step. */
  const rewrite = (node: HTMLElement, text: string): void => {
    setText(node, text);
    textOf.set(node, text);
    body.scrollTop = body.scrollHeight;
  };

  /**
   * The one door out of the device, asked for in the visitor's own transcript.
   *
   * NO `window.confirm`: a native dialog on somebody else's website is the host page's furniture,
   * it blocks their whole tab, and it cannot show the text that is about to be sent. This is a
   * bubble with the message in it and two buttons, and nothing leaves until one is pressed.
   */
  const confirmAsk = (question: string, detail?: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const box = el("div", { className: "mini-ask" }, [el("p", { textContent: question })]);
      if (detail) box.append(el("p", { className: "mini-note", textContent: detail }));
      const yes = el("button", { className: "yes", type: "button", textContent: "Send" });
      const no = el("button", { type: "button", textContent: "Not now" });
      const answer = (value: boolean): void => {
        box.replaceChildren(
          el("p", { className: "mini-note", textContent: value ? "Sent to the site owner." : "Nothing was sent." }),
        );
        resolve(value);
      };
      yes.addEventListener("click", () => answer(true));
      no.addEventListener("click", () => answer(false));
      box.append(yes, no);
      body.append(box);
      body.scrollTop = body.scrollHeight;
      yes.focus();
    });

  const ownerMessage = (text: string): void => {
    const node = el("div", { className: "mini-row owner" }, [
      el("b", { textContent: "From the site owner" }),
      el("div", { className: "mini-md" }),
    ]);
    setText(node, text);
    body.append(node);
    body.scrollTop = body.scrollHeight;
    transcript.push({ who: "them", text: `From the site owner: ${text}` });
    park(deps.ref, { open, transcript });
  };

  const suggest = (hits: { url: string; title: string; heading: string; passage: string }[]): void => {
    for (const hit of hits) {
      const button = el("button", { className: "mini-hit", type: "button" }, [
        el("b", { textContent: hit.title || pathOf(hit.url) }),
        el("span", { textContent: `${pathOf(hit.url)} · ${hit.heading}` }),
        el("div", { textContent: hit.passage }),
      ]);
      button.addEventListener("click", () => {
        park(deps.ref, { open: true, transcript });
        deps.page.open(hit.url);
      });
      body.append(button);
    }
    body.scrollTop = body.scrollHeight;
  };

  // The panel runs tools itself on the no-brain path. Same `ToolContext` the runtime would give
  // them, with the same in-memory thread sandbox — nothing about it survives the tab.
  const fs = threadFs();
  const runTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const tool = deps.tools.find((t) => t.schema.name === name);
    if (!tool) return `no such tool: ${name}`;
    const res = await tool.run(args, { fs, sandbox: "threads/embed", signal: new AbortController().signal, emit: () => {} });
    return res.output;
  };

  // ── the two answer paths ───────────────────────────────────────────────────────────────────
  const answerWithBrain = async (question: string, active: Brain): Promise<void> => {
    const bubble = say("them", "…", false);
    live = bubble;
    drawFace(true);
    try {
      const result = await active.ask(question);
      const said = result.text || (textOf.get(bubble) === "…" ? "I could not find that on this site." : textOf.get(bubble) ?? "");
      rewrite(bubble, said);
      transcript.push({ who: "them", text: said });
    } catch (err) {
      rewrite(bubble, `That did not work (${String(err)}). The site search still does.`);
    } finally {
      live = null;
      drawFace(false);
    }
  };

  const answerWithoutBrain = async (question: string): Promise<void> => {
    const plan = planNoBrainReply(question);
    const status = say("status", plan.status, false);

    const hits = deps.index.search(plan.subject, plan.intent === "where" ? 3 : 5);
    if (!hits.length && plan.steps.some((s) => s.tool === "site_crawl")) {
      await runTool("site_crawl", { hint: plan.subject });
    }
    const found = hits.length ? hits : deps.index.search(plan.subject, 5);
    status.remove();

    if (!found.length) {
      say("them", `I could not find "${plan.subject}" on this site.`);
      return;
    }

    if (plan.intent === "where") {
      // "where is X" → search, then point at the control that means X on the page in front of them.
      const here = deps.page.current();
      const target = matchLandmark(plan.subject, here.tree.map((n) => ({ name: n.name, ref: n.ref })));
      if (target) {
        deps.page.highlight(target.target, target.name);
        say("them", `It is on this page: "${target.name}" — I have outlined it.`);
      } else {
        say("them", `Here is where ${plan.subject} lives on this site:`);
      }
    } else {
      say("them", found.length === 1 ? "Here it is:" : "Here is what I found:");
    }
    suggest(found);
    transcript.push({ who: "status", text: `${found.length} result(s) for ${plan.subject}` });
  };

  const ask = async (question: string): Promise<void> => {
    if (busy || !question.trim()) return;
    busy = true;
    deps.page.clearHighlights();
    say("me", question);
    input.value = "";
    try {
      if (brain) await answerWithBrain(question, brain);
      else await answerWithoutBrain(question);
    } finally {
      busy = false;
      park(deps.ref, { open: true, transcript });
    }
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void ask(input.value);
  });
  // Enter, explicitly. A form's implicit submission is not reliable inside a shadow root across
  // engines, and "I typed my question and nothing happened" is the worst first impression there is.
  input.addEventListener("keydown", (e) => {
    const key = e as KeyboardEvent;
    if (key.key !== "Enter" || key.isComposing) return;
    key.preventDefault();
    void ask(input.value);
  });

  // ── the local-AI offer: shown, never taken automatically (§5.2.3) ───────────────────────────
  if (!brain) {
    const offer = el("div", { className: "mini-offer" }, [
      el("p", { textContent: "Answers here come from this site's own pages. A small AI can talk them through — it downloads to this device only." }),
    ]);
    // The licence is named where the download is offered, not after it: a model's terms bind the
    // person who runs it, and Gemma's carry use restrictions they must be able to read first.
    const m = deps.localAi.model;
    const licence = el("p", { className: "mini-licence" }, [
      el("span", { textContent: `${m.name} · ` }),
      el("a", { href: m.licenseUrl, target: "_blank", rel: "noopener", textContent: m.licenseName }),
    ]);
    if (m.useRestrictionsUrl) {
      licence.append(el("span", { textContent: " · " }), el("a", { href: m.useRestrictionsUrl, target: "_blank", rel: "noopener", textContent: "use restrictions" }));
    }
    offer.append(licence);
    // Said BEFORE the button, not after a failed download: a browser with no WebGPU may manage
    // neither of the two, and a quarter of a gigabyte is not a thing to find that out with.
    if (deps.localAi.note) offer.append(el("p", { className: "mini-licence", textContent: deps.localAi.note }));
    const button = el("button", { type: "button", textContent: `Load local AI · ${deps.localAi.sizeMb} MB` });
    button.addEventListener("click", () => {
      button.disabled = true;
      button.textContent = "Loading…";
      void deps.localAi
        .load((line) => (button.textContent = line.slice(0, 40)))
        .then((loaded) => {
          if (!loaded) {
            button.textContent = "Not available in this browser";
            return;
          }
          brain = loaded.brain;
          input.placeholder = "Ask about this site";
          offer.remove();
          say("status", `${loaded.model.name} is ready. It runs on this device, and the download stays here.`);
        })
        .catch(() => (button.textContent = "Could not load"));
    });
    offer.append(button);
    body.append(offer);
  }

  // ── footer, gear, launcher ─────────────────────────────────────────────────────────────────
  clear.addEventListener("click", () => {
    void deps.clearMemory().then(() => {
      transcript.length = 0;
      body.replaceChildren();
      say("status", "Cleared. Nothing about this site is kept on this device.");
    });
  });

  /**
   * The owner's setup is a MODAL over the panel, not a screen inside it (§5.2.4, DESIGN.md).
   *
   * Built on the first press of the gear and then kept: the answers a person has given survive a
   * close, and the register card of §5.3 keeps whatever the registry told it. It lives in the same
   * closed shadow root as everything else here — the flow never puts a node on the host page.
   */
  let setup: SetupHandle | null = null;
  const setupHost = el("div");
  wrap.append(setupHost);
  gear.addEventListener("click", () => {
    setup ??= renderSetup(setupHost, {
      origin: deps.origin,
      ref: deps.ref,
      productHost: deps.productHost,
      fetchImpl: deps.fetchImpl,
      // The header and the launcher ARE step 1's preview, so they follow the answers.
      onApply: (next) => {
        deps.applyConfig(next);
        relabel(next);
      },
      ...(deps.admin ? { admin: deps.admin } : {}),
      // The notes the carriers produced (a rejected site file, a clamped field) are the owner's
      // business, and the review step is where an owner is reading about their settings.
      ...(deps.notes.length ? { notes: deps.notes } : {}),
      localAi: {
        sizeMb: deps.localAi.sizeMb,
        model: deps.localAi.model,
        ...(deps.localAi.note ? { note: deps.localAi.note } : {}),
      },
      linkPub: deps.config.linkPub ?? "",
      onClose: () => input.focus(),
    });
    setup.open();
  });

  /** Step 1 of the setup, applied: the name and the line a visitor reads are these. */
  const relabel = (next: SiteConfig): void => {
    const name = next.intro.name || MINI_NAME;
    title.querySelector(".mini-title")!.textContent = name;
    title.querySelector(".mini-sub")!.textContent = next.intro.line || `${deps.index.size()} pages known`;
    launcher.lastElementChild!.textContent = name;
    panel.setAttribute("aria-label", name);
  };

  const setOpen = (next: boolean): void => {
    const changed = next !== open;
    open = next;
    panel.dataset.open = next ? "1" : "0";
    launcher.style.display = next ? "none" : "";
    park(deps.ref, { open: next, transcript });
    if (next) input.focus();
    if (changed) deps.onOpenChange?.(next);
  };
  launcher.addEventListener("click", () => setOpen(true));
  close.addEventListener("click", () => setOpen(false));
  deps.shadow.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape") setOpen(false);
  });
  // A click anywhere in the host page clears the outline — §5.2.2 says the highlight lasts until
  // the next message or the next click, and a stale ring on somebody's page is litter.
  window.addEventListener("click", () => deps.page.clearHighlights(), { capture: true });

  // Resume after a navigation the panel itself asked for.
  const parked = readParked(deps.ref);
  if (parked) {
    for (const line of parked.transcript) say(line.who, line.text, false);
    transcript.push(...parked.transcript);
    if (parked.open) setOpen(true);
  } else if (deps.needsSetup) {
    // The owner is the first person to open the panel on a site with no settings yet (§5.2.4).
    say("status", "No settings found for this site. The gear sets it up.");
  }

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    isOpen: () => open,
    confirm: confirmAsk,
    ownerMessage,
    crawlProgress,
    /**
     * The runtime's events, while a turn is in flight: text streams into the waiting bubble.
     *
     * The bubble's words are read back from `textOf` rather than from the DOM, because the DOM now
     * holds RENDERED markdown — asking an element what its text is would hand back the rendering,
     * and appending the next token to that would slowly turn the answer into its own output.
     */
    onAgentEvent: (event) => {
      if (!live) return;
      const soFar = textOf.get(live) ?? "";
      if (event.type === "agent_message") rewrite(live, event.text);
      if (event.type === "tool_started" && soFar === "…") rewrite(live, `looking (${event.name})…`);
      if (event.type === "error") rewrite(live, event.message);
      // `agent_delta` is landing in @00/agent-runtime as this is written, and its payload may be
      // `delta` or `text`. Read through a widened view so the panel compiles and behaves both
      // before and after the union carries it: a token stream appends, a whole message replaces.
      const streaming = event as { type: string; delta?: unknown; text?: unknown };
      if (streaming.type === "agent_delta") {
        const piece = typeof streaming.delta === "string" ? streaming.delta : typeof streaming.text === "string" ? streaming.text : "";
        rewrite(live, (soFar === "…" ? "" : soFar) + piece);
      }
    },
  };
}

/** The sponsor-footer slot: the provider's `footer` is shown, never fed back to a model. */
export function setSponsorFooter(shadow: ShadowRoot, text: string): void {
  const slot = shadow.querySelector(".mini-sponsor");
  if (slot) slot.textContent = text.slice(0, 120);
}

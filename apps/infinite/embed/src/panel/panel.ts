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
import { renderSetup } from "./setup.js";
import { PANEL_CSS } from "./styles.js";

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
}

export interface PanelHandle {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  onAgentEvent(event: AgentEvent): void;
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
  const wrap = el("div", { className: "wrap" });
  const panel = el("div", { className: "panel" });
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", deps.config.intro.name || "Site guide");

  const body = el("div", { className: "body" });
  const input = el("input", { type: "text", placeholder: brain ? "Ask about this site" : "Search this site" });
  input.setAttribute("aria-label", "Ask about this site");
  const form = el("form", {}, [input, el("button", { className: "send", type: "submit", textContent: "Ask" })]);

  const title = el("div", {}, [
    el("div", { className: "name", textContent: deps.config.intro.name || "Site guide" }),
    el("div", { className: "line", textContent: deps.config.intro.line || `${deps.index.size()} pages known` }),
  ]);
  const gear = el("button", { className: "iconbtn", type: "button", textContent: "⚙", title: "Owner setup" });
  const close = el("button", { className: "iconbtn", type: "button", textContent: "✕", title: "Close" });
  const header = el("header", {}, [title, el("div", { className: "grow" }), gear, close]);

  const clear = el("button", { type: "button", textContent: "Clear memory" });
  const sponsor = el("div", { className: "sponsor" });
  const footer = el("footer", {}, [clear, el("span", { textContent: "· on your device only" }), sponsor]);

  panel.append(header, body, form, footer);
  const launcher = el("button", { className: "launcher", type: "button" }, [
    el("span", { className: "dot" }),
    el("span", { textContent: deps.config.intro.name || "Ask about this site" }),
  ]);
  wrap.append(panel, launcher);
  deps.shadow.append(wrap);

  // ── transcript ─────────────────────────────────────────────────────────────────────────────
  const say = (who: "me" | "them" | "status", text: string, remember = true): HTMLElement => {
    const node = el("div", { className: `msg ${who === "me" ? "me" : who === "status" ? "status" : ""}`, textContent: text });
    body.append(node);
    body.scrollTop = body.scrollHeight;
    if (remember) transcript.push({ who, text });
    return node;
  };

  const suggest = (hits: { url: string; title: string; heading: string; passage: string }[]): void => {
    for (const hit of hits) {
      const button = el("button", { className: "hit", type: "button" }, [
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
    try {
      const result = await active.ask(question);
      bubble.textContent = result.text || bubble.textContent.replace(/^…$/, "I could not find that on this site.");
      transcript.push({ who: "them", text: bubble.textContent });
    } catch (err) {
      bubble.textContent = `That did not work (${String(err)}). The site search still does.`;
    } finally {
      live = null;
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
    const offer = el("div", { className: "offer" }, [
      el("p", { textContent: "Answers here come from this site's own pages. A small AI can talk them through — it downloads to this device only." }),
    ]);
    // The licence is named where the download is offered, not after it: a model's terms bind the
    // person who runs it, and Gemma's carry use restrictions they must be able to read first.
    const m = deps.localAi.model;
    const licence = el("p", { className: "licence" }, [
      el("span", { textContent: `${m.name} · ` }),
      el("a", { href: m.licenseUrl, target: "_blank", rel: "noopener", textContent: m.licenseName }),
    ]);
    if (m.useRestrictionsUrl) {
      licence.append(el("span", { textContent: " · " }), el("a", { href: m.useRestrictionsUrl, target: "_blank", rel: "noopener", textContent: "use restrictions" }));
    }
    offer.append(licence);
    // Said BEFORE the button, not after a failed download: a browser with no WebGPU may manage
    // neither of the two, and a quarter of a gigabyte is not a thing to find that out with.
    if (deps.localAi.note) offer.append(el("p", { className: "licence", textContent: deps.localAi.note }));
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

  gear.addEventListener("click", () => {
    body.replaceChildren();
    const host = el("div");
    body.append(host);
    if (deps.notes.length) for (const note of deps.notes) say("status", note, false);
    renderSetup(host, {
      origin: deps.origin,
      ref: deps.ref,
      productHost: deps.productHost,
      fetchImpl: deps.fetchImpl,
      onApply: deps.applyConfig,
    });
  });

  const setOpen = (next: boolean): void => {
    open = next;
    panel.dataset.open = next ? "1" : "0";
    launcher.style.display = next ? "none" : "";
    park(deps.ref, { open: next, transcript });
    if (next) input.focus();
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
    /** The runtime's events, while a turn is in flight: text streams into the waiting bubble. */
    onAgentEvent: (event) => {
      if (event.type === "agent_message" && live) live.textContent = event.text;
      if (event.type === "tool_started" && live && live.textContent === "…") live.textContent = `looking (${event.name})…`;
      if (event.type === "error" && live) live.textContent = event.message;
      // `agent_delta` is landing in @00/agent-runtime as this is written, and its payload may be
      // `delta` or `text`. Read through a widened view so the panel compiles and behaves both
      // before and after the union carries it: a token stream appends, a whole message replaces.
      const streaming = event as { type: string; delta?: unknown; text?: unknown };
      if (streaming.type === "agent_delta" && live) {
        const piece = typeof streaming.delta === "string" ? streaming.delta : typeof streaming.text === "string" ? streaming.text : "";
        live.textContent = (live.textContent === "…" ? "" : (live.textContent ?? "")) + piece;
      }
    },
  };
}

/** The sponsor-footer slot: the provider's `footer` is shown, never fed back to a model. */
export function setSponsorFooter(shadow: ShadowRoot, text: string): void {
  const slot = shadow.querySelector(".sponsor");
  if (slot) slot.textContent = text.slice(0, 120);
}

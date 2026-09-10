/**
 * The owner's setup flow, rendered (§5.2.4). The decisions and the documents it produces are in
 * setup-model.ts; this file is inputs, a preview, and two copy buttons.
 *
 * WHY it lives inside the panel and not in a console of ours: there is no account at level 0 and no
 * server of ours to log in to. The person who pasted the snippet is the first to open the panel on
 * their own site, and that is the entire authentication story for this flow — which is also why it
 * ends by handing them a file to save or a tag to paste, and never by storing anything anywhere.
 */

import type { SiteConfig } from "../site-config.js";
import {
  SETUP_STEPS,
  WELL_KNOWN_PATH,
  buildSiteConfig,
  checkSiteFile,
  defaultAnswers,
  isDevOrigin,
  sessionKindHelp,
  siteFileText,
  snippetFor,
  type SetupAnswers,
} from "./setup-model.js";

export interface SetupOptions {
  origin: string;
  ref: string;
  /** The product host the snippet points at, e.g. https://infinite.0-0.chat */
  productHost: string;
  fetchImpl: typeof fetch;
  onApply(config: SiteConfig): void;
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

const list = (value: string): string[] =>
  value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

export function renderSetup(container: HTMLElement, opts: SetupOptions): void {
  const answers: SetupAnswers = defaultAnswers(opts.origin);
  const dev = isDevOrigin(opts.origin);

  const wrap = el("div", { className: "setup" });
  wrap.append(el("h2", { textContent: "Set up your agent" }));

  // ── 1. This site ───────────────────────────────────────────────────────────────────────────
  const step1 = step(0);
  step1.append(
    el("div", {
      className: "rule",
      textContent: `It reads ${opts.origin} and nothing else. Ever. Not a setting — a rule.`,
    }),
  );
  if (dev) {
    step1.append(el("p", { className: "note", textContent: "Dev mode: this is a local origin." }));
    step1.append(el("label", { textContent: "The domain it will finally live on (optional)" }));
    const domain = el("input", { type: "text", placeholder: "https://example.com" });
    domain.addEventListener("input", () => (answers.finalDomain = domain.value.trim()));
    step1.append(domain);
  }

  // ── 2. What the agent may read ─────────────────────────────────────────────────────────────
  const step2 = step(1);
  const depth = el("select");
  depth.append(el("option", { value: "1", textContent: "1 — this page and its links" }));
  depth.append(el("option", { value: "2", textContent: "2 — and their links (default)" }));
  depth.value = String(answers.depth);
  depth.addEventListener("change", () => (answers.depth = Number(depth.value)));
  step2.append(el("label", { textContent: "How deep to look on load" }), depth);

  const ttl = el("input", { type: "number", min: "1", max: "365", value: String(answers.ttlDays) });
  ttl.addEventListener("input", () => (answers.ttlDays = Number(ttl.value)));
  step2.append(el("label", { textContent: "Keep a page for (days)" }), ttl);

  for (const [key, label, placeholder] of [
    ["includes", "Only these paths (one per line, blank = all)", "/help"],
    ["excludes", "Never these paths", "/drafts"],
    ["doNotTouch", "Do not touch (added to the built-in guard)", "/cart"],
  ] as const) {
    const box = el("textarea", { rows: 2, placeholder });
    box.addEventListener("input", () => ((answers[key] as string[]) = list(box.value)));
    step2.append(el("label", { textContent: label }), box);
  }

  const auto = el("input", { type: "checkbox", checked: true });
  const autoRow = el("div", { className: "row" }, [auto, el("span", { textContent: "Auto knowledge base" })]);
  step2.append(
    autoRow,
    el("p", {
      className: "note",
      textContent: "Indexes a visitor's signed-in pages on that visitor's own device. It never leaves the device.",
    }),
  );

  const sessionBox = el("div");
  const kind = el("select");
  for (const [value, label] of [
    ["cookie", "A cookie"],
    ["localStorage", "localStorage"],
    ["temporary", "A temporary session"],
    ["none", "I don't know"],
  ] as const) {
    kind.append(el("option", { value, textContent: label }));
  }
  kind.value = "none";
  const kindHelp = el("p", { className: "note", textContent: sessionKindHelp("none") });
  const names = el("input", { type: "text", placeholder: "session_id, auth.token" });
  const namesLabel = el("label", { textContent: "Names (never values)" });
  const logout = el("input", { type: "text", placeholder: "/logout, /account/signout" });

  const syncKind = (): void => {
    answers.sessionKind = kind.value as SetupAnswers["sessionKind"];
    kindHelp.textContent = sessionKindHelp(answers.sessionKind);
    const wantsNames = answers.sessionKind === "cookie" || answers.sessionKind === "localStorage";
    names.hidden = !wantsNames;
    namesLabel.hidden = !wantsNames;
  };
  kind.addEventListener("change", syncKind);
  names.addEventListener("input", () => {
    const parsed = list(names.value);
    answers.cookies = answers.sessionKind === "cookie" ? parsed : [];
    answers.storageKeys = answers.sessionKind === "localStorage" ? parsed : [];
  });
  logout.addEventListener("input", () => (answers.logoutPaths = list(logout.value)));
  sessionBox.append(
    el("label", { textContent: "How is a visitor's session kept on this site?" }),
    kind,
    kindHelp,
    namesLabel,
    names,
    el("label", { textContent: "Sign-out path(s), so a logout is caught even when the signal is invisible" }),
    logout,
  );
  syncKind();
  auto.addEventListener("change", () => {
    answers.crawlAuthed = auto.checked;
    sessionBox.hidden = !auto.checked;
  });
  step2.append(sessionBox);

  // ── 3. How it introduces itself ────────────────────────────────────────────────────────────
  const step3 = step(2);
  const name = el("input", { type: "text", placeholder: "The Acme guide" });
  name.addEventListener("input", () => (answers.introName = name.value));
  const line = el("input", { type: "text", placeholder: "I know this site. Ask me where anything is." });
  line.addEventListener("input", () => (answers.introLine = line.value));
  const knowledge = el("textarea", { rows: 2, placeholder: "/.well-known/infinite-agent/persona.md\n/faq.md" });
  knowledge.addEventListener("input", () => (answers.knowledge = list(knowledge.value)));
  step3.append(
    el("label", { textContent: "Name" }),
    name,
    el("label", { textContent: "One line" }),
    line,
    el("label", { textContent: "Knowledge files on this site (same origin, 256 KB in total, text only)" }),
    knowledge,
  );

  // ── 4. Where to keep these settings ────────────────────────────────────────────────────────
  const step4 = step(3);
  const carrier = el("select");
  carrier.append(el("option", { value: "site-file", textContent: `A file on my site (${WELL_KNOWN_PATH})` }));
  carrier.append(el("option", { value: "snippet", textContent: "In the snippet (re-paste to change a setting)" }));
  const output = el("pre");
  const copyBtn = el("button", { className: "copy", textContent: "Copy" });
  const snippetOut = el("pre");
  const copySnippet = el("button", { className: "copy", textContent: "Copy the snippet" });
  const checkBtn = el("button", { className: "copy", textContent: "Check the file is live" });
  const checkOut = el("p", { className: "note" });

  const refresh = (): void => {
    answers.carrier = carrier.value as SetupAnswers["carrier"];
    const config = buildSiteConfig(answers, opts.ref);
    output.textContent = answers.carrier === "site-file" ? siteFileText(config) : "";
    output.hidden = answers.carrier !== "site-file";
    copyBtn.hidden = answers.carrier !== "site-file";
    checkBtn.hidden = answers.carrier !== "site-file";
    snippetOut.textContent = snippetFor(opts.productHost, opts.ref, config, answers.carrier);
    opts.onApply(config);
  };
  carrier.addEventListener("change", refresh);
  for (const input of [depth, ttl, kind, names, logout, name, line, knowledge, auto]) {
    input.addEventListener("change", refresh);
    input.addEventListener("input", refresh);
  }
  copyBtn.addEventListener("click", () => copy(output.textContent ?? "", copyBtn));
  copySnippet.addEventListener("click", () => copy(snippetOut.textContent ?? "", copySnippet));
  checkBtn.addEventListener("click", () => {
    checkOut.textContent = "Checking…";
    void checkSiteFile(opts.origin, opts.ref, opts.fetchImpl).then((r) => (checkOut.textContent = r.message));
  });

  step4.append(
    carrier,
    el("label", { textContent: `Save this at ${WELL_KNOWN_PATH}` }),
    output,
    copyBtn,
    checkBtn,
    checkOut,
    el("label", { textContent: "The snippet for your pages" }),
    snippetOut,
    copySnippet,
  );

  // ── 5. Optional, later ─────────────────────────────────────────────────────────────────────
  const step5 = step(4);
  for (const [title, needs] of [
    ["Register and claim it", "an app on this browser; proves the agent is yours"],
    ["Publish its knowledge", "a claimed app; serves your persona without a file on the site"],
    ["Get messages from visitors", "a claimed app; the inbox door"],
    ["Give it a stronger brain", "a claimed app, or a local model on the visitor's device"],
  ]) {
    step5.append(el("div", { className: "rule", textContent: `${title} — needs ${needs}` }));
  }

  container.replaceChildren(wrap);
  refresh();

  function step(i: number): HTMLElement {
    const meta = SETUP_STEPS[i]!;
    const box = el("div", { className: "step" }, [
      el("b", { textContent: `${i + 1}. ${meta.title}` }),
      el("p", { className: "blurb", textContent: meta.blurb }),
    ]);
    wrap.append(box);
    return box;
  }
}

function copy(text: string, button: HTMLElement): void {
  const label = button.textContent ?? "Copy";
  void navigator.clipboard
    ?.writeText(text)
    .then(() => {
      button.textContent = "Copied";
      setTimeout(() => (button.textContent = label), 1400);
    })
    .catch(() => (button.textContent = "Copy failed — select it by hand"));
}

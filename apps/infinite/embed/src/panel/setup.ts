/**
 * The owner's setup flow, rendered as a CENTRED MODAL WIZARD (§5.2.4). The decisions and the
 * documents it produces are in setup-model.ts and wizard-model.ts; this file is one screen at a
 * time, a progress row, and two copy buttons at the end.
 *
 * WHY it lives inside the panel and not in a console of ours: there is no account at level 0 and no
 * server of ours to log in to. The person who pasted the snippet is the first to open the panel on
 * their own site, and that is the entire authentication story for this flow — which is also why it
 * ends by handing them a file to save or a tag to paste, and never by storing anything anywhere.
 *
 * WHY A MODAL AND NOT THE PANEL BODY. Setting up an agent is a different job from talking to one:
 * it asks a dozen questions and it is done once. Rendered into the 400 px transcript it was a long
 * scroll of every question at once, with the chat it replaced sitting underneath it. As a modal it
 * is one question a screen, the transcript is still there behind the dim, and the widget's own
 * furniture (the launcher, the composer) does not have to pretend to be a form. It is still inside
 * the SAME closed shadow root — the flow never puts a node on the host page (§13).
 */

import type { ClaimNonceResult, RegisterResult } from "../registry/client.js";
import { normalisePath, type SiteConfig } from "../site-config.js";
import { MINI_NAME, pixelFaceSvg } from "../../../src/mini/brand.js";
import {
  WELL_KNOWN_PATH,
  checkSiteFile,
  describeClaimNonce,
  describeRegistration,
  isDevOrigin,
  sessionKindHelp,
  type RegistrationView,
  type SetupAnswers,
} from "./setup-model.js";
import {
  PERSONA_SUGGESTION,
  SITE_FILE_NAME,
  WIZARD_STEPS,
  carrierOutputs,
  defaultWizardAnswers,
  summarise,
  validateStep,
  wizardSiteConfig,
  type WizardAnswers,
} from "./wizard-model.js";

/**
 * What step 4's Register card is given (§5.3, §5.4).
 *
 * Actions, not a client: the flow asks to register and asks for the claim link, and everything about
 * how those are fetched — and whether a registry exists at all — belongs to `registry/client.ts`.
 * `openTab` is injectable because a test has no window and because opening one is the single
 * side-effect on this card.
 */
export interface AdminFlow {
  register(): Promise<RegisterResult>;
  claimUrl(): string | null;
  /**
   * Ask the registry for a fresh claim code (§5.4). Absent ⇒ the button is not shown at all, which
   * is what a build pointed at a worker without the route should do: the card says where the one
   * claim link went and stops there, rather than offering a door that answers 404.
   */
  reissueClaim?(): Promise<ClaimNonceResult>;
  openTab?(url: string): void;
}

/** What step 4's first card names, so the licence is read BEFORE any download (§5.2.3). */
export interface LocalAiCard {
  sizeMb: number;
  model: { name: string; licenseName: string; licenseUrl: string; useRestrictionsUrl?: string };
  note?: string;
}

export interface SetupOptions {
  origin: string;
  ref: string;
  /** The product host the snippet points at, e.g. https://infinite.0-0.chat */
  productHost: string;
  fetchImpl: typeof fetch;
  onApply(config: SiteConfig): void;
  /** The owner's agent key already in force, so re-opening the gear does not lose it. */
  linkPub?: string;
  /** Absent ⇒ step 4 offers the device and "later" only, and says nothing about registering. */
  admin?: AdminFlow;
  /** Owner-facing notes about the settings in force: a rejected site file, a clamped field. */
  notes?: string[];
  /** The model the panel would offer, named on step 4's first card. */
  localAi?: LocalAiCard;
  /** Told when the modal closes, so the panel can put focus back where it was. */
  onClose?(): void;
}

export interface SetupHandle {
  open(): void;
  close(): void;
  isOpen(): boolean;
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

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select, textarea, a[href]";

export function renderSetup(container: HTMLElement, opts: SetupOptions): SetupHandle {
  const answers: WizardAnswers = { ...defaultWizardAnswers(opts.origin), linkPub: opts.linkPub ?? "" };
  const dev = isDevOrigin(opts.origin);
  const host = hostOf(opts.origin);

  let at = 0;
  /** True once anything has been typed: the only reason a close asks a question. */
  let dirty = false;
  let open = false;

  // ── the modal ──────────────────────────────────────────────────────────────────────────────
  const modal = el("div", { className: "mini-modal" });
  modal.dataset.open = "0";
  const backdrop = el("div", { className: "mini-modal-backdrop" });
  const card = el("div", { className: "mini-wizard" });
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-labelledby", "mini-wizard-title");

  const face = el("div", { className: "mini-face", innerHTML: pixelFaceSvg({ size: 26 }) });
  const heading = el("h2", { id: "mini-wizard-title", textContent: `Set up ${MINI_NAME} for ${host}` });
  const closeBtn = el("button", { className: "mini-icon", type: "button", textContent: "✕", title: "Close" });
  const head = el("div", { className: "mini-wizard-head" }, [face, heading, closeBtn]);

  const stepsRow = el("div", { className: "mini-steps" });
  stepsRow.setAttribute("aria-label", "Setup steps");
  const stepButtons = WIZARD_STEPS.map((step, i) => {
    const button = el("button", { className: "mini-step", type: "button" }, [
      el("i", { textContent: String(i + 1) }),
      el("span", { textContent: step.label }),
    ]);
    button.addEventListener("click", () => {
      if (i < at) go(i);
    });
    stepsRow.append(button);
    return button;
  });

  const body = el("div", { className: "mini-wizard-body" });
  body.addEventListener("input", () => (dirty = true));
  body.addEventListener("change", () => (dirty = true));

  const foot = el("div", { className: "mini-wizard-foot" });
  const backBtn = el("button", { type: "button", textContent: "Back" });
  const skipBtn = el("button", { className: "mini-grow", type: "button", textContent: "Skip" });
  const nextBtn = el("button", { className: "primary", type: "button", textContent: "Next" });
  const footError = el("p", { className: "mini-error" });
  backBtn.addEventListener("click", () => go(at - 1));
  skipBtn.addEventListener("click", () => go(at + 1));
  nextBtn.addEventListener("click", () => {
    if (WIZARD_STEPS[at]!.id === "review") {
      finish();
      return;
    }
    const wrong = validateStep(WIZARD_STEPS[at]!.id, answers);
    if (wrong) {
      footError.textContent = wrong;
      return;
    }
    go(at + 1);
  });

  card.append(head, stepsRow, body, foot);
  modal.append(backdrop, card);
  container.append(modal);

  // ── the doors out ──────────────────────────────────────────────────────────────────────────
  backdrop.addEventListener("click", () => requestClose());
  closeBtn.addEventListener("click", () => requestClose());
  card.addEventListener("keydown", (event) => {
    const e = event as KeyboardEvent;
    if (e.key === "Escape") {
      // The panel closes on Escape too (panel.ts listens on the shadow root). While the wizard is
      // up, Escape is the wizard's: one key, one meaning, the nearest thing first.
      e.stopPropagation();
      e.preventDefault();
      requestClose();
      return;
    }
    if (e.key !== "Tab") return;
    // The trap. A modal that lets Tab walk out onto the host page behind it is not a modal, and on
    // somebody else's website "behind it" is a page we do not control.
    const stops = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => !n.hidden && n.offsetParent !== null);
    if (!stops.length) return;
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    const active = card.getRootNode() instanceof ShadowRoot ? (card.getRootNode() as ShadowRoot).activeElement : document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  });

  function requestClose(): void {
    if (!dirty) {
      close();
      return;
    }
    // NEVER `window.confirm`: a native dialog on somebody else's website blocks their whole tab and
    // is the host page's furniture, not ours (the same rule the visitor's confirm follows).
    foot.replaceChildren(
      el("p", { className: "mini-note", textContent: "Discard changes?" }),
      el("span", { className: "mini-grow" }),
      keep(),
      discard(),
    );
    function keep(): HTMLButtonElement {
      const b = el("button", { type: "button", textContent: "Keep editing" });
      b.addEventListener("click", () => paintFoot());
      return b;
    }
    function discard(): HTMLButtonElement {
      const b = el("button", { className: "primary", type: "button", textContent: "Discard" });
      b.addEventListener("click", () => close());
      return b;
    }
  }

  function close(): void {
    open = false;
    modal.dataset.open = "0";
    opts.onClose?.();
  }

  function finish(): void {
    opts.onApply(wizardSiteConfig(answers, opts.ref, "site-file"));
    dirty = false;
    close();
  }

  // ── the walk ───────────────────────────────────────────────────────────────────────────────
  function go(next: number): void {
    at = Math.max(0, Math.min(WIZARD_STEPS.length - 1, next));
    paint();
  }

  function paint(): void {
    const step = WIZARD_STEPS[at]!;
    for (const [i, button] of stepButtons.entries()) {
      button.dataset.state = i < at ? "done" : i === at ? "current" : "next";
      button.disabled = i > at;
      if (i === at) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    }
    footError.textContent = "";
    const built = screenFor(step.id);
    body.replaceChildren(
      el("h3", { textContent: step.title }),
      el("p", { className: "mini-note", textContent: step.help }),
      ...built.nodes,
    );
    body.scrollTop = 0;
    paintFoot();
    // preventScroll: focusing a control far down a screen (the review's first Copy) would otherwise
    // scroll the body to it, and every step must start at its own first line.
    built.focus?.focus({ preventScroll: true });
  }

  function paintFoot(): void {
    const step = WIZARD_STEPS[at]!;
    backBtn.disabled = at === 0;
    nextBtn.textContent = step.id === "review" ? "Done" : "Next";
    skipBtn.hidden = !step.optional;
    foot.replaceChildren(backBtn, footError, step.optional ? skipBtn : el("span", { className: "mini-grow" }), nextBtn);
  }

  // ── the five screens ───────────────────────────────────────────────────────────────────────
  function screenFor(id: (typeof WIZARD_STEPS)[number]["id"]): { nodes: Node[]; focus?: HTMLElement } {
    if (id === "intro") return introScreen();
    if (id === "read") return readScreen();
    if (id === "knowledge") return knowledgeScreen();
    if (id === "brain") return brainScreen();
    return reviewScreen();
  }

  function introScreen(): { nodes: Node[]; focus?: HTMLElement } {
    const nodes: Node[] = [
      el("div", {
        className: "mini-rule",
        textContent: `It reads ${opts.origin} and nothing else. Ever. Not a setting — a rule.`,
      }),
    ];

    const name = el("input", { type: "text", maxLength: 64, placeholder: "The Acme guide", value: answers.introName });
    const line = el("input", {
      type: "text",
      maxLength: 200,
      placeholder: "I know this site. Ask me where anything is.",
      value: answers.introLine,
    });

    // The launcher, as the visitor will see it. The same class the real one wears, so it is the
    // widget itself rather than a drawing of it.
    const pill = el("span", { className: "mini-launcher" }, [
      el("span", { className: "mini-face", innerHTML: pixelFaceSvg({ size: 22 }) }),
      el("span", { textContent: answers.introName.trim() || MINI_NAME }),
    ]);
    pill.setAttribute("aria-hidden", "true");
    const preview = el("div", { className: "mini-preview" }, [pill]);

    name.addEventListener("input", () => {
      answers.introName = name.value;
      pill.lastElementChild!.textContent = name.value.trim() || MINI_NAME;
    });
    line.addEventListener("input", () => (answers.introLine = line.value));

    nodes.push(
      field("Name", name, "Blank is fine — it is called 00 Mini then."),
      field("One line", line, "Shown under the name, at the top of the panel."),
      preview,
    );

    if (dev) {
      const domain = el("input", { type: "text", placeholder: "https://example.com", value: answers.finalDomain });
      domain.addEventListener("input", () => (answers.finalDomain = domain.value.trim()));
      nodes.push(
        el("p", { className: "mini-note", textContent: "Dev mode: this is a local origin." }),
        field("The domain it will finally live on (optional)", domain),
      );
    }
    return { nodes, focus: name };
  }

  function readScreen(): { nodes: Node[]; focus?: HTMLElement } {
    const depth = el("select");
    depth.append(el("option", { value: "1", textContent: "1 — this page and its links" }));
    depth.append(el("option", { value: "2", textContent: "2 — and their links (default)" }));
    depth.value = String(answers.depth);
    depth.addEventListener("change", () => (answers.depth = Number(depth.value)));

    const ttl = el("input", { type: "number", min: "1", max: "365", value: String(answers.ttlDays) });
    ttl.addEventListener("input", () => (answers.ttlDays = Number(ttl.value)));

    const nodes: Node[] = [
      field("How deep to look on load", depth),
      field("Keep a page for (days)", ttl, "After that it is read again. 1 to 365."),
      pathChips("Only these paths", "/help", "Blank means all of them.", () => answers.includes, (v) => (answers.includes = v)),
      pathChips("Pages it must never touch", "/drafts", "Prefixes. Added to the built-in guard, never instead of it.", () => answers.excludes, (v) => (answers.excludes = v)),
      pathChips("Do not touch", "/cart", "Anything that acts when it is opened.", () => answers.doNotTouch, (v) => (answers.doNotTouch = v)),
    ];

    const auto = el("input", { type: "checkbox", checked: answers.crawlAuthed });
    const autoId = "mini-crawl-authed";
    auto.id = autoId;
    const autoRow = el("div", { className: "mini-field row" }, [
      auto,
      el("label", { htmlFor: autoId, textContent: "Read signed-in pages" }),
    ]);
    nodes.push(
      autoRow,
      el("p", {
        className: "mini-note",
        textContent: "Indexes a visitor's signed-in pages on that visitor's own device. It never leaves the device.",
      }),
    );

    const sessionBox = el("div", { className: "mini-wizard-group" });
    const kind = el("select");
    for (const [value, label] of [
      ["cookie", "A cookie"],
      ["localStorage", "localStorage"],
      ["temporary", "A temporary session"],
      ["none", "I don't know"],
    ] as const) {
      kind.append(el("option", { value, textContent: label }));
    }
    kind.value = answers.sessionKind;
    const kindHelp = el("p", { className: "mini-note", textContent: sessionKindHelp(answers.sessionKind) });
    const names = el("input", { type: "text", placeholder: "session_id, auth.token" });
    names.value = (answers.sessionKind === "cookie" ? answers.cookies : answers.storageKeys).join(", ");
    const namesField = field("Names (never values)", names);

    const syncKind = (): void => {
      answers.sessionKind = kind.value as SetupAnswers["sessionKind"];
      kindHelp.textContent = sessionKindHelp(answers.sessionKind);
      const wantsNames = answers.sessionKind === "cookie" || answers.sessionKind === "localStorage";
      namesField.hidden = !wantsNames;
    };
    kind.addEventListener("change", syncKind);
    names.addEventListener("input", () => {
      const parsed = names.value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      answers.cookies = answers.sessionKind === "cookie" ? parsed : [];
      answers.storageKeys = answers.sessionKind === "localStorage" ? parsed : [];
    });

    sessionBox.append(
      field("How is a visitor's session kept on this site?", kind),
      kindHelp,
      namesField,
      pathChips(
        "The paths that mean signed out",
        "/logout",
        "So a sign-out is caught even when the signal is invisible.",
        () => answers.logoutPaths,
        (v) => (answers.logoutPaths = v),
      ),
      el("p", {
        className: "mini-note",
        textContent: "On one of those paths every signed-in page is deleted from that visitor's device, index and all.",
      }),
    );
    syncKind();
    sessionBox.hidden = !auto.checked;
    auto.addEventListener("change", () => {
      answers.crawlAuthed = auto.checked;
      sessionBox.hidden = !auto.checked;
    });
    nodes.push(sessionBox);
    return { nodes, focus: depth };
  }

  function knowledgeScreen(): { nodes: Node[]; focus?: HTMLElement } {
    const persona = el("input", { type: "text", placeholder: PERSONA_SUGGESTION, value: answers.personaPath });
    persona.addEventListener("input", () => (answers.personaPath = persona.value.trim()));
    const suggest = el("button", { className: "mini-copy", type: "button", textContent: `Use ${PERSONA_SUGGESTION}` });
    suggest.addEventListener("click", () => {
      persona.value = PERSONA_SUGGESTION;
      answers.personaPath = PERSONA_SUGGESTION;
      dirty = true;
    });
    return {
      nodes: [
        field(
          "The persona line",
          persona,
          "One file of your own words — who this agent is, and how it should answer. Same origin, text.",
        ),
        suggest,
        pathChips(
          "Knowledge files on this site",
          "/faq.md",
          "Same origin, 256 KB in total, text only.",
          () => answers.knowledge,
          (v) => (answers.knowledge = v),
        ),
      ],
      focus: persona,
    };
  }

  function brainScreen(): { nodes: Node[]; focus?: HTMLElement } {
    const cards = el("div", { className: "mini-cards" });
    const made: HTMLButtonElement[] = [];

    const pick = (value: WizardAnswers["brain"]): void => {
      answers.brain = value;
      dirty = true;
      for (const b of made) b.dataset.picked = b.dataset.value === value ? "1" : "0";
      registerBox.hidden = value !== "router";
    };

    const add = (value: WizardAnswers["brain"], title: string, lines: (string | Node)[]): HTMLButtonElement => {
      const button = el("button", { className: "mini-card", type: "button" }, [el("b", { textContent: title })]);
      button.dataset.value = value;
      for (const l of lines) button.append(typeof l === "string" ? el("p", { textContent: l }) : l);
      button.addEventListener("click", () => pick(value));
      cards.append(button);
      made.push(button);
      return button;
    };

    const local = opts.localAi;
    const licence = el("p", { className: "mini-licence" });
    if (local) {
      licence.append(
        el("span", { textContent: `${local.model.name} · ` }),
        el("a", { href: local.model.licenseUrl, target: "_blank", rel: "noopener", textContent: local.model.licenseName }),
      );
      if (local.model.useRestrictionsUrl) {
        licence.append(
          el("span", { textContent: " · " }),
          el("a", { href: local.model.useRestrictionsUrl, target: "_blank", rel: "noopener", textContent: "use restrictions" }),
        );
      }
    }
    const first = add("local", "On the visitor's device", [
      local
        ? `A small model, ${local.sizeMb} MB, downloaded only when that visitor asks for it. No account, and nothing leaves their device.`
        : "A small model, downloaded only when that visitor asks for it. No account, and nothing leaves their device.",
      ...(local ? [licence] : []),
      ...(local?.note ? [el("p", { className: "mini-licence", textContent: local.note })] : []),
    ]);

    if (opts.admin) {
      add("router", "Extra power through the 00 router", [
        "Register this site as an app and a bigger brain answers instead. Optional; needs an account at that moment.",
      ]);
    }
    add("later", "Later", ["Nothing now. The site search answers on its own, and the gear reopens this."]);

    const registerBox = registerCard();
    registerBox.hidden = answers.brain !== "router";

    const nodes: Node[] = [
      cards,
      el("p", {
        className: "mini-note",
        textContent:
          "Registration is never required. A site set up on the first card is finished: it searches its own pages with no brain at all, and talks them through with the one on the visitor's device.",
      }),
    ];
    if (opts.admin) nodes.push(registerBox);
    for (const b of made) b.dataset.picked = b.dataset.value === answers.brain ? "1" : "0";
    return { nodes, focus: first };
  }

  function reviewScreen(): { nodes: Node[]; focus?: HTMLElement } {
    const out = carrierOutputs(answers, opts.ref, opts.productHost);
    // The live panel takes the settings as the owner reads them back, so "Done" only has to close.
    opts.onApply(out.fileConfig);

    const summary = el("div", { className: "mini-summary" });
    for (const row of summarise(answers, opts.ref)) {
      const jump = el("button", { className: "mini-jump", type: "button", textContent: "Change" });
      jump.addEventListener("click", () => go(WIZARD_STEPS.findIndex((s) => s.id === row.step)));
      summary.append(el("div", {}, [el("b", { textContent: row.label }), el("span", { textContent: row.value }), jump]));
    }

    const nodes: Node[] = [summary];
    for (const note of opts.notes ?? []) nodes.push(el("p", { className: "mini-note", textContent: note }));

    // ── carrier (a): the file on the site ────────────────────────────────────────────────────
    const fileOut = el("pre", { className: "mini-pre", textContent: out.fileText });
    const copyFile = el("button", { className: "mini-copy", type: "button", textContent: "Copy" });
    copyFile.addEventListener("click", () => copy(out.fileText, copyFile));
    const download = el("button", { className: "mini-copy", type: "button", textContent: `Download ${SITE_FILE_NAME}` });
    download.addEventListener("click", () => save(out.fileText, SITE_FILE_NAME, card));
    const checkBtn = el("button", { className: "mini-copy", type: "button", textContent: "Check the file is live" });
    const checkOut = el("p", { className: "mini-note" });
    checkBtn.addEventListener("click", () => {
      checkOut.textContent = "Checking…";
      void checkSiteFile(opts.origin, opts.ref, opts.fetchImpl).then((r) => (checkOut.textContent = r.message));
    });
    const fileCard = el("div", { className: "mini-card" }, [
      el("b", { textContent: "A file on your site" }),
      el("p", { textContent: `Save it at ${WELL_KNOWN_PATH}. The snippet then never changes again — settings are edited in the file.` }),
      fileOut,
      el("div", { className: "mini-card-foot" }, [copyFile, download, checkBtn]),
      checkOut,
      el("p", { className: "mini-note", textContent: "The tag for your pages:" }),
      el("pre", { className: "mini-pre", textContent: out.bareSnippet }),
    ]);

    // ── carrier (b): the tag itself ──────────────────────────────────────────────────────────
    const snippetOut = el("pre", { className: "mini-pre", textContent: out.snippet });
    const copySnippet = el("button", { className: "mini-copy", type: "button", textContent: "Copy" });
    copySnippet.addEventListener("click", () => copy(out.snippet, copySnippet));
    const tagCard = el("div", { className: "mini-card" }, [
      el("b", { textContent: "In the script tag" }),
      el("p", { textContent: "For a host where you can paste a script but cannot add a file. Changing a setting means pasting again." }),
      snippetOut,
      el("div", { className: "mini-card-foot" }, [copySnippet]),
    ]);

    nodes.push(
      el("p", { className: "mini-note", textContent: "Two ways to carry these settings. Either one works — with both, the file wins." }),
      el("div", { className: "mini-cards" }, [fileCard, tagCard]),
    );
    return { nodes, focus: copyFile };
  }

  // ── the register card (§5.3, §5.4), built once so its state survives a step change ─────────
  let registerNode: HTMLElement | null = null;
  function registerCard(): HTMLElement {
    if (registerNode) return registerNode;
    const box = el("div", { className: "mini-wizard-group" });
    registerNode = box;
    const admin = opts.admin;
    if (!admin) return box;

    // The key belongs with Register, and it is A FIELD OF THE SETTINGS DOCUMENT, so the review's
    // two carriers are rebuilt from it when the owner goes forward.
    const linkPubInput = el("input", { type: "text", placeholder: "43 characters, base64url", value: answers.linkPub });
    linkPubInput.addEventListener("input", () => (answers.linkPub = linkPubInput.value.trim()));

    const registerOut = el("div", { className: "mini-rule" });
    const registerDetail = el("p", { className: "mini-note" });
    const registerBtn = el("button", { className: "mini-copy", type: "button", textContent: "Register this site" });
    const claimBtn = el("button", { className: "mini-copy", type: "button", textContent: "Claim it in your agent" });
    const REISSUE_LABEL = "Get a new claim link";
    const reissueBtn = el("button", { className: "mini-copy", type: "button", textContent: REISSUE_LABEL });
    claimBtn.hidden = true;
    reissueBtn.hidden = true;
    registerOut.hidden = true;

    registerBtn.addEventListener("click", () => {
      registerBtn.disabled = true;
      registerBtn.textContent = "Registering…";
      void admin
        .register()
        .then((result) => render(describeRegistration(result, admin.claimUrl())))
        .catch((err: unknown) => {
          registerOut.hidden = false;
          registerOut.textContent = `That did not work (${String(err)}).`;
        })
        .finally(() => {
          registerBtn.disabled = false;
          registerBtn.textContent = "Register this site";
        });
    });

    // The claim link is asked for AFTER the answer, never before: `requestClaimNonce` is what puts
    // the new code in this browser, so `claimUrl()` only has one to build once that has resolved.
    const render = (view: RegistrationView): void => {
      registerOut.hidden = false;
      registerOut.textContent = view.headline;
      registerDetail.textContent = view.detail;
      claimBtn.hidden = !view.action;
      reissueBtn.hidden = !view.reissue || !admin.reissueClaim;
      if (view.action) {
        claimBtn.textContent = view.action.label;
        claimBtn.onclick = () => {
          const url = view.action!.url;
          // A new tab, never this one: the owner is in the middle of setting up their site, and
          // navigating away from it would lose the answers they have been giving.
          if (admin.openTab) admin.openTab(url);
          else window.open(url, "_blank", "noopener");
        };
      }
    };

    reissueBtn.addEventListener("click", () => {
      const ask = admin.reissueClaim;
      if (!ask) return;
      reissueBtn.disabled = true;
      reissueBtn.textContent = "Asking the registry…";
      void ask()
        .then((result) => render(describeClaimNonce(result, admin.claimUrl())))
        .catch((err: unknown) => {
          registerOut.hidden = false;
          registerOut.textContent = `That did not work (${String(err)}).`;
        })
        .finally(() => {
          reissueBtn.disabled = false;
          reissueBtn.textContent = REISSUE_LABEL;
        });
    });

    box.append(
      field("Your agent's public key (from the Infinite Agent app)", linkPubInput),
      el("p", {
        className: "mini-note",
        textContent:
          "Public by design, like the snippet. It is stored when the site registers, and it is what proves the claim is yours.",
      }),
      el("div", { className: "mini-card-foot" }, [registerBtn, claimBtn, reissueBtn]),
      registerOut,
      registerDetail,
    );
    return box;
  }

  // ── small furniture ────────────────────────────────────────────────────────────────────────
  function field(label: string, control: HTMLElement, help?: string, under: Node[] = []): HTMLElement {
    const id = `mini-f${++fieldSeq}`;
    control.id = id;
    const nodes: Node[] = [el("label", { htmlFor: id, textContent: label }), control, ...under];
    if (help) nodes.push(el("p", { className: "mini-note", textContent: help }));
    return el("div", { className: "mini-field" }, nodes);
  }
  let fieldSeq = 0;

  /**
   * A path list as chips. Typed one at a time, shown as what they are, removable one at a time —
   * a textarea of newline-separated paths made a typo invisible until the document was built.
   * Anything that could leave the origin is refused HERE as well as in the validator, so the owner
   * is told why rather than watching a line disappear.
   */
  function pathChips(
    label: string,
    placeholder: string,
    help: string,
    get: () => string[],
    set: (next: string[]) => void,
  ): HTMLElement {
    const chips = el("div", { className: "mini-chips" });
    const input = el("input", { type: "text", placeholder });
    const error = el("p", { className: "mini-error" });

    const paint = (): void => {
      chips.replaceChildren();
      for (const path of get()) {
        const remove = el("button", { type: "button", textContent: "×" });
        remove.setAttribute("aria-label", `Remove ${path}`);
        remove.addEventListener("click", () => {
          set(get().filter((p) => p !== path));
          dirty = true;
          paint();
        });
        chips.append(el("span", { className: "mini-chip" }, [el("span", { textContent: path }), remove]));
      }
    };

    const commit = (): void => {
      const raw = input.value.trim();
      if (!raw) return;
      const added: string[] = [];
      for (const piece of raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)) {
        const path = normalisePath(piece);
        if (!path) {
          error.textContent = `"${piece}" is not a path on this site — it must start with / and stay here.`;
          return;
        }
        if (!get().includes(path) && !added.includes(path)) added.push(path);
      }
      error.textContent = "";
      set([...get(), ...added]);
      input.value = "";
      dirty = true;
      paint();
    };

    input.addEventListener("keydown", (event) => {
      const e = event as KeyboardEvent;
      if (e.key !== "Enter" && e.key !== ",") return;
      e.preventDefault();
      commit();
    });
    input.addEventListener("blur", commit);
    paint();

    // The chips sit UNDER the box that adds them, where what you just typed appears; above it they
    // read as the tail of the question before.
    return field(label, input, help, [chips, error]);
  }

  paint();

  return {
    open: () => {
      open = true;
      modal.dataset.open = "1";
      paint();
    },
    close,
    isOpen: () => open,
  };
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
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

/** The site file, saved. A blob and an anchor: nothing of ours is touched to produce it. */
function save(text: string, filename: string, within: HTMLElement): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.hidden = true;
  within.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * The owner's setup, as a WIZARD — one question a screen, in order, with a review at the end.
 * The modal that renders it is setup.ts; everything decidable without a DOM is here.
 *
 * WHY a second model file next to setup-model.ts: setup-model.ts owns the DOCUMENT (§5.2.4's
 * `site.json`, its clamps and its two carriers) and that is a contract with the loader's validator.
 * This file owns the WALK — which screen comes after which, what may be skipped, what is wrong with
 * the answers so far, and what the review reads back. The walk is the thing Bruno asked to change;
 * the document must not move when it does, so the two are not the same file.
 *
 * The order is the order a person can answer in, not the order §5.2.4 lists:
 *   1. Name and line — the only thing a visitor ever sees, so it is asked first.
 *   2. What it may read — the crawl, its bounds, and what a sign-out means.
 *   3. Knowledge and persona — optional, and said to be optional.
 *   4. Brain — on the visitor's device, or (only for an owner who wants it) the 00 router.
 *      REGISTRATION IS NEVER REQUIRED (§5.3–5.4): local AI alone is a finished product.
 *   5. Review and install — every answer read back, then both carriers side by side.
 */

import {
  LIMITS,
  normalisePath,
  type SiteConfig,
} from "../site-config.js";
import {
  WELL_KNOWN_PATH,
  buildSiteConfig,
  defaultAnswers,
  siteFileText,
  snippetFor,
  type SetupAnswers,
} from "./setup-model.js";

export type WizardStepId = "intro" | "read" | "knowledge" | "brain" | "review";

export interface WizardStep {
  id: WizardStepId;
  /** The word in the progress row. Two or three of them, because five must fit on a phone. */
  label: string;
  /** The one question this screen asks. */
  title: string;
  /** The line under it. Short, plain, and true. */
  help: string;
  /** Optional steps show a Skip; nothing in them is needed to finish. */
  optional: boolean;
}

export const WIZARD_STEPS: WizardStep[] = [
  {
    id: "intro",
    label: "Name",
    title: "Name and line",
    help: "What a visitor sees on the launcher and at the top of the panel.",
    optional: false,
  },
  {
    id: "read",
    label: "Reading",
    title: "What it may read",
    help: "It only ever reads this one site. Here you say how much of it, and what to leave alone.",
    optional: false,
  },
  {
    id: "knowledge",
    label: "Knowledge",
    title: "Knowledge and persona",
    help: "Text files on your own site the agent may quote. You can skip this and add them later.",
    optional: true,
  },
  {
    id: "brain",
    label: "Brain",
    title: "Which brain answers",
    help: "The agent already searches your pages with no brain at all. A brain talks them through.",
    optional: false,
  },
  {
    id: "review",
    label: "Install",
    title: "Review and install",
    help: "Every answer, then the two ways to carry it. Either one works; you do not need both.",
    optional: false,
  },
];

/**
 * Which brain the owner picked on step 4.
 *
 * `router` is the ONLY value that involves an account, it is offered only when this build can talk
 * to a registry at all, and it is never the default. A site set up on `local` is finished.
 */
export type BrainChoice = "local" | "router" | "later";

export interface WizardAnswers extends SetupAnswers {
  brain: BrainChoice;
  /**
   * The persona file — one path, kept apart from `knowledge` so the wizard can ask for it by name
   * and suggest the standard place for it. It is merged into `knowledge` (first, deduped) when the
   * document is built: `site.json` has one list, and adding a field to it would be a field the
   * loader's validator drops (§5.2.4, "unknown fields are dropped").
   */
  personaPath: string;
}

export const PERSONA_SUGGESTION = "/.well-known/infinite-agent/persona.md";
/** What the site file is saved as. The path it goes to is `WELL_KNOWN_PATH`. */
export const SITE_FILE_NAME = "infinite-agent.json";

export function defaultWizardAnswers(origin: string): WizardAnswers {
  return { ...defaultAnswers(origin), brain: "local", personaPath: "" };
}

/** The persona file in front, the listed files after it, nothing twice. */
export function wizardKnowledge(answers: WizardAnswers): string[] {
  const persona = normalisePath(answers.personaPath);
  if (!persona) return answers.knowledge;
  return [persona, ...answers.knowledge.filter((p) => normalisePath(p) !== persona)];
}

/** The `site.json` these answers describe, for one carrier. The clamps are setup-model's. */
export function wizardSiteConfig(
  answers: WizardAnswers,
  ref: string,
  carrier: SetupAnswers["carrier"],
): SiteConfig {
  return buildSiteConfig({ ...answers, knowledge: wizardKnowledge(answers), carrier }, ref);
}

export interface CarrierOutputs {
  /** Where the file goes, and what to call it when it is downloaded. */
  path: string;
  filename: string;
  /** The file itself, pretty-printed. */
  fileText: string;
  fileConfig: SiteConfig;
  /** The tag, with the same settings encoded in `data-site` (§5.1, carrier 3). */
  snippet: string;
  snippetConfig: SiteConfig;
  /** The tag for an owner who saved the file: bare, and it never changes again. */
  bareSnippet: string;
}

/**
 * Step 5's two documents, built from one set of answers.
 *
 * BOTH ARE BUILT, ALWAYS. The old flow made the owner choose a carrier before it would show them
 * anything; a person who cannot add a file to their site root does not know that about themselves
 * until they have tried. So the review shows the file and the tag side by side and lets the site
 * decide — §5.1's precedence means having both is harmless, the file simply wins.
 */
export function carrierOutputs(answers: WizardAnswers, ref: string, productHost: string): CarrierOutputs {
  const fileConfig = wizardSiteConfig(answers, ref, "site-file");
  const snippetConfig = wizardSiteConfig(answers, ref, "snippet");
  return {
    path: WELL_KNOWN_PATH,
    filename: SITE_FILE_NAME,
    fileText: siteFileText(fileConfig),
    fileConfig,
    snippet: snippetFor(productHost, ref, snippetConfig, "snippet"),
    snippetConfig,
    bareSnippet: snippetFor(productHost, ref, fileConfig, "site-file"),
  };
}

/**
 * What is wrong with this screen, in the owner's words, or null.
 *
 * Only what would produce a document that does not say what they meant. A blank name is fine (the
 * panel falls back to the product's own), a blank everything is fine — the defaults are a working
 * agent. What is not fine is an answer the document would silently drop.
 */
export function validateStep(id: WizardStepId, answers: WizardAnswers): string | null {
  if (id === "intro") {
    if (answers.introName.trim().length > LIMITS.introName) {
      return `The name is longer than ${LIMITS.introName} characters.`;
    }
    if (answers.introLine.trim().length > LIMITS.introLine) {
      return `The line is longer than ${LIMITS.introLine} characters.`;
    }
    if (answers.finalDomain.trim() && !/^https?:\/\/[^\s/]+/i.test(answers.finalDomain.trim())) {
      return "The final domain needs its https:// — for example, https://example.com";
    }
    return null;
  }
  if (id === "read") {
    if (answers.depth !== 1 && answers.depth !== 2) return "Depth is 1 or 2.";
    const ttl = Math.trunc(answers.ttlDays);
    if (!Number.isFinite(ttl) || ttl < 1 || ttl > 365) return "Keep a page for 1 to 365 days.";
    if (answers.crawlAuthed && answers.sessionKind === "cookie" && !answers.cookies.length) {
      return "Name the cookie, or pick another kind of session.";
    }
    if (answers.crawlAuthed && answers.sessionKind === "localStorage" && !answers.storageKeys.length) {
      return "Name at least one key, or pick another kind of session.";
    }
    return null;
  }
  // knowledge is optional, brain always has a choice, and review has nothing left to get wrong.
  return null;
}

/** The first step whose answers are wrong, or -1. What Next uses to refuse, and the review to warn. */
export function firstInvalidStep(answers: WizardAnswers): number {
  return WIZARD_STEPS.findIndex((s) => validateStep(s.id, answers) !== null);
}

export interface SummaryLine {
  label: string;
  value: string;
  /** Which step to go back to when the owner disagrees with a line. */
  step: WizardStepId;
}

const listOr = (values: string[], fallback: string): string => (values.length ? values.join(", ") : fallback);

/**
 * Every answer, read back in the words the screens used. Built from the DOCUMENT rather than the
 * raw answers wherever the document clamps something, so the review shows what will actually ship.
 */
export function summarise(answers: WizardAnswers, ref: string): SummaryLine[] {
  const config = wizardSiteConfig(answers, ref, "site-file");
  const session = config.session;
  const sessionNames = session.kind === "cookie" ? session.cookies : session.kind === "localStorage" ? session.storageKeys : [];
  const brain =
    answers.brain === "local"
      ? "On the visitor's device, when they ask for it"
      : answers.brain === "router"
        ? "Through the 00 router, once this site is registered and claimed"
        : "Decided later";

  return [
    { label: "Name", value: config.intro.name || "00 Mini", step: "intro" },
    { label: "One line", value: config.intro.line || "—", step: "intro" },
    { label: "Reads", value: answers.origin, step: "intro" },
    ...(answers.finalDomain.trim() ? [{ label: "Final domain", value: answers.finalDomain.trim(), step: "intro" as const }] : []),
    { label: "Depth on load", value: config.depth === 1 ? "1 — this page and its links" : "2 — and their links", step: "read" },
    { label: "Keep a page for", value: `${config.ttlDays} day(s)`, step: "read" },
    { label: "Only these paths", value: listOr(config.includes, "all of them"), step: "read" },
    { label: "Never these paths", value: listOr(config.excludes, "none beyond the built-in guard"), step: "read" },
    { label: "Do not touch", value: listOr(config.doNotTouch, "none beyond the built-in guard"), step: "read" },
    {
      label: "Signed-in pages",
      value: config.crawlAuthed ? "Indexed on that visitor's own device" : "Never read",
      step: "read",
    },
    {
      label: "Session",
      value: config.crawlAuthed ? `${sessionLabel(session.kind)}${sessionNames.length ? ` (${sessionNames.join(", ")})` : ""}` : "—",
      step: "read",
    },
    { label: "Sign-out paths", value: listOr(session.logoutPaths, "guessed from the page"), step: "read" },
    { label: "Persona file", value: normalisePath(answers.personaPath) ?? "none", step: "knowledge" },
    { label: "Knowledge files", value: listOr(config.knowledge, "none"), step: "knowledge" },
    { label: "Brain", value: brain, step: "brain" },
  ];
}

function sessionLabel(kind: SiteConfig["session"]["kind"]): string {
  switch (kind) {
    case "cookie":
      return "A cookie";
    case "localStorage":
      return "localStorage";
    case "temporary":
      return "A temporary session";
    case "none":
      return "Guessed from the page";
  }
}

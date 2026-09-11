/**
 * WHAT THE LANDING PAGE SAYS — the copy and the section table, as data.
 *
 * WHY THE WORDS LIVE IN A MODULE. Two readers need them: the page draws them, and the agent floating
 * over the page is TOLD about them, so that "where do I set the vault?" can end with the page
 * scrolled to `#vault` rather than with a paragraph. A section list hand-written twice would drift,
 * and the drift would be an agent pointing at an anchor that no longer exists.
 *
 * EVERY CLAIM HERE IS A THING THAT SHIPS (DESIGN.md, "Voice"). What is not live is said to be not
 * live, in the same sentence — the live hand-over over the relay, and hosted registration. The rest
 * is checked against docs/HANDOFF-infinite-agent.md §4, §5 and §7.
 */

export interface LandingSection {
  /** The anchor, without the `#`. The agent scrolls to these. */
  id: string;
  /** The heading a person reads, and the name the agent uses for the place. */
  title: string;
  /** One line, for the agent's map of the page. */
  summary: string;
}

/** The order of the page, and the agent's index of it. */
export const LANDING_SECTIONS: LandingSection[] = [
  { id: "hero", title: "An AI agent you don't install", summary: "What this is, and the widget in the corner that is already running." },
  { id: "code", title: "Everything a coding agent has", summary: "Files, an editor, a terminal, Git, a live preview, and Node with npm — in the tab." },
  { id: "mobile", title: "It works on your phone", summary: "The same app on a phone, installable to the home screen as a PWA." },
  { id: "file", title: "The whole agent is one file", summary: "Download, back up, restore, or hand it to the 00 Mac app as one encrypted .00agent." },
  { id: "qr", title: "Bring it with you", summary: "A QR code opens the receive flow on the other device. The file road works today." },
  { id: "vault", title: "Encrypted at rest", summary: "The vault opens with a passkey or a password; embedded agents never hold secrets." },
  { id: "offline", title: "No account, and it works offline", summary: "Nothing to sign up for, offline after the first load, one agent per browser profile." },
  { id: "brains", title: "The brains", summary: "Gemma on your own GPU, or sponsored answers, or your own keys." },
  { id: "embed", title: "Put it on your website", summary: "One script tag puts this same widget on any site you own." },
  { id: "faq", title: "Questions", summary: "Six short answers: storage, privacy, cost, browsers, limits, and leaving." },
];

/** `#code` — what shipped in the power shell (§1's row, BuiltinShell, the JS runner, virtual ports). */
export const CODE_POINTS: { icon: string; title: string; body: string }[] = [
  {
    icon: "folder",
    title: "Files and an editor",
    body: "A real filesystem in the browser's own storage, a tree, and an editor with the agent writing beside you.",
  },
  {
    icon: "tools",
    title: "A terminal",
    body: "A shell with the commands built in — ls, cat, grep, sed, git — running on those same files, not on a server.",
  },
  {
    icon: "brain",
    title: "Node and npm",
    body: "node runs your script in a worker, and npm installs into the tab's own node_modules. No container, no machine.",
  },
  {
    icon: "world",
    title: "A live preview",
    body: "A dev server on a virtual port, served by the service worker, so the page you are building opens beside the chat.",
  },
  {
    icon: "refresh",
    title: "Git",
    body: "Init, status, diff, commit, branch — the history lives in the same storage as the files it belongs to.",
  },
  {
    icon: "sparkles",
    title: "One runtime",
    body: "The same agent loop 00 runs on a Mac, on a server and in a container. Here the host is a tab.",
  },
];

export interface ModelRow {
  name: string;
  size: string;
  role: string;
  licence: string;
  /** Under the Gemma Terms of Use rather than Apache-2.0 — linked, never summarised. */
  gemma?: boolean;
  vision?: boolean;
}

/** §12.7's mirror, live on dl.0-0.chat/litert. Sizes are the download. */
export const MODELS: ModelRow[] = [
  { name: "Gemma 4 E2B", size: "2.0 GB", role: "The default on a laptop. Text.", licence: "Apache-2.0" },
  { name: "Gemma 4 E4B", size: "3.0 GB", role: "Stronger, same machine. Text.", licence: "Apache-2.0" },
  { name: "Gemma 4 12B", size: "6.0 GB", role: "If you have the VRAM for it. Text.", licence: "Apache-2.0" },
  { name: "Gemma 3n E2B", size: "3.0 GB", role: "Sees pictures.", licence: "Gemma terms", gemma: true, vision: true },
  { name: "Gemma 3n E4B", size: "4.3 GB", role: "The same, larger.", licence: "Gemma terms", gemma: true, vision: true },
  { name: "Gemma 3 1B", size: "0.7 GB", role: "Small desktops and good phones.", licence: "Gemma terms", gemma: true },
  { name: "Gemma 3 270M", size: "0.25 GB", role: "Phones, and the embed's local AI.", licence: "Gemma terms", gemma: true },
];

export const GEMMA_TERMS_URL = "https://dl.0-0.chat/litert/GEMMA_TERMS.md";
export const GEMMA_NOTICE_URL = "https://dl.0-0.chat/litert/NOTICE.txt";
export const TERMS_URL = "https://0-0.chat/terms";
export const PRIVACY_URL = "https://0-0.chat/privacy";

/** `#embed` — the two halves of the promise to a site owner (§13). */
export const EMBED_CAN = [
  "Know every page of your site, and which one answers the question.",
  "Search the words on those pages, not a summary of them.",
  "Open the right page, and keep the conversation across the load.",
  "Scroll to the button and draw an outline around it.",
  "Read the knowledge files you list — your FAQ, your persona.",
];

export const EMBED_CANNOT = [
  "It never clicks, fills or submits anything. It shows the person where the button is.",
  "It reads your origin only, with plain GETs, and never follows a link off your site.",
  "It has no vault and holds no secrets — an embedded agent has nothing worth stealing.",
  "What it reads stays in the visitor's browser. Not uploaded, not to us, not to you.",
];

export const FAQ: { q: string; a: string }[] = [
  {
    q: "Where does the agent actually live?",
    a: "In this browser's own storage — its files, its sessions and its memory. One agent per browser profile; a different browser is a different agent.",
  },
  {
    q: "Do you see anything I type?",
    a: "Not when the brain is on your device: the model runs on your GPU and nothing leaves. Answers from a hosted brain go to that provider, and the chip in the composer always names which one is answering.",
  },
  {
    q: "What does it cost?",
    a: "Nothing to open, nothing to install, no account. A local model costs you the download. A hosted brain costs whatever you already pay for it — your own key, your own credits.",
  },
  {
    q: "Which browsers work?",
    a: "Anything current with WebGPU for the local models; without WebGPU the app still runs and says so, and a hosted brain answers instead. Safari, Chrome and Edge all install it to the home screen.",
  },
  {
    q: "What happens if I clear my browser data?",
    a: "The agent goes with it. That is why the export is one file and the app asks to be installed: installed storage is not evicted after a week of not visiting. Back it up like anything else you would miss.",
  },
  {
    q: "Can I leave?",
    a: "Download the .00agent and you have all of it — files, memory, sessions. Open it in the 00 Mac app and it carries on there. Nothing of ours has to be running for that file to be yours.",
  },
];

/** One line naming every anchor, for the agent's context on the landing page. */
export function sectionMapLine(sections: LandingSection[] = LANDING_SECTIONS): string {
  return sections.map((s) => `#${s.id} ${s.title}`).join(" · ");
}

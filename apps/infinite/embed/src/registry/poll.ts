/**
 * THE VISITOR'S SIDE OF A CONVERSATION — polling for the owner's reply (§5.6, "the webchat pattern").
 *
 * WHY POLLING AND NOT A SOCKET: the reply may come in a minute or in a day, and the visitor is on
 * somebody else's website with a panel that closes when they navigate away. A socket held open on
 * every page of every site running the embed would be a cost with no matching benefit — there is
 * nothing to stream. Thirty seconds is the plan's own "webchat pattern" cadence and it is slow
 * enough that a visitor who leaves the panel open for an hour costs the registry 120 signed GETs.
 *
 * WHY IT ONLY RUNS WHILE THE PANEL IS OPEN: a closed panel has nowhere to put a reply. The loader
 * starts this when the panel opens and stops it when it closes or the tab goes away, so a site with
 * a thousand readers and no open panels makes no calls at all — the same rule as the rest of Phase 3.
 *
 * WHY REPLIES ARE DEDUPED BY `mid` AND NOT BY A CURSOR: what the poller has to decide is "have I
 * already SHOWN this reply", and no timestamp answers that — the worker's own `since` on this route
 * is a `repliedAt` and always returns an unanswered item whatever the cursor says, which is right for
 * the wire and says nothing about what reached the panel. So the poller re-reads its own short list
 * (twenty items an hour at the outside) and remembers the mids it has spoken.
 */

import type { MessagesResult, RegistryClient, VisitorMessage } from "./client.js";

/** §5.6's webchat cadence. */
export const POLL_INTERVAL_MS = 30_000;

export interface PollerOptions {
  poll: () => Promise<MessagesResult>;
  /** Called once per reply, in the order the owner sent them. */
  onReply: (message: VisitorMessage) => void;
  /** Called when a poll is refused, so the panel can say so once rather than every 30 s. */
  onRefusal?: (code: string, message: string) => void;
  intervalMs?: number;
  /** Injectable timers, so the cadence is a test and not a wait. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ReplyPoller {
  /** Idempotent: opening a panel that is already polling does nothing. */
  start(): void;
  stop(): void;
  running(): boolean;
  /** One round now, off the schedule — what "the visitor just sent something" does. */
  tick(): Promise<void>;
  /** The mids whose replies have already been shown. */
  seen(): string[];
}

export function createReplyPoller(opts: PollerOptions): ReplyPoller {
  const interval = opts.intervalMs ?? POLL_INTERVAL_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const shown = new Set<string>();
  let handle: unknown = null;
  let live = false;
  let lastRefusal = "";

  const round = async (): Promise<void> => {
    const result = await opts.poll();
    if (!result.ok) {
      // Said ONCE. A registry that is down must not fill a visitor's transcript with the same
      // sentence twice a minute.
      if (result.code !== lastRefusal) {
        lastRefusal = result.code;
        opts.onRefusal?.(result.code, result.message);
      }
      return;
    }
    lastRefusal = "";
    // Oldest first: the worker answers newest-first, and a conversation reads the other way.
    const replies = result.messages.filter((m) => m.reply && !shown.has(m.mid)).reverse();
    for (const message of replies) {
      shown.add(message.mid);
      opts.onReply(message);
    }
  };

  const schedule = (): void => {
    if (!live) return;
    handle = setTimer(() => {
      void round().finally(schedule);
    }, interval);
  };

  return {
    start() {
      if (live) return;
      live = true;
      schedule();
    },
    stop() {
      live = false;
      if (handle !== null) clearTimer(handle);
      handle = null;
    },
    running: () => live,
    tick: round,
    seen: () => [...shown],
  };
}

/** Convenience: the poller a panel wants, reading this browser's own device conversation. */
export function pollerFor(
  client: RegistryClient,
  onReply: (message: VisitorMessage) => void,
  extra: Partial<PollerOptions> = {},
): ReplyPoller {
  return createReplyPoller({ poll: () => client.pollMessages(), onReply, ...extra });
}

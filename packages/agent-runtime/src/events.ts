/**
 * The one channel every other module in the runtime speaks on.
 *
 * The UI, the recorder and the tests all read the SAME AgentEvent stream — that is the point. A
 * shell that renders a tool call, a test that asserts a permission was asked for, and a replay of a
 * session for a bug report are three readers of one list, so nothing in the loop is allowed to
 * report progress any other way (no callbacks per surface, no console, no return-value-only steps).
 *
 * `on()` returns its own unsubscribe rather than taking an `off(listener)`: a listener registered
 * twice would otherwise be un-registered once, and the runtime hands listeners out to panes that
 * mount and unmount.
 */
import type { AgentEvent } from "./api.js";

export type AgentEventListener = (event: AgentEvent) => void;

export class EventBus {
  private listeners = new Set<AgentEventListener>();

  on(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * A listener that throws must never break the loop that emitted — a broken pane is a broken pane,
   * not a failed run — so every delivery is isolated and the throw is dropped here.
   */
  emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* a listener's fault is the listener's problem */
      }
    }
  }

  count(): number {
    return this.listeners.size;
  }

  clear(): void {
    this.listeners.clear();
  }
}

export interface RecordedEvent {
  at: number;
  event: AgentEvent;
}

/**
 * Keeps every event a run emitted, so a test (or a bug report) can replay it into a fresh listener
 * and assert on the whole shape of a turn rather than on one callback at a time.
 */
export class EventRecorder {
  private recorded: RecordedEvent[] = [];
  private unsubscribe?: () => void;

  constructor(
    bus?: EventBus,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (bus) this.unsubscribe = bus.on((event) => this.recorded.push({ at: this.now(), event }));
  }

  /** Attach to a second bus, or re-attach after `stop()`. */
  attach(bus: EventBus): this {
    this.stop();
    this.unsubscribe = bus.on((event) => this.recorded.push({ at: this.now(), event }));
    return this;
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  events(): AgentEvent[] {
    return this.recorded.map((r) => r.event);
  }

  timeline(): RecordedEvent[] {
    return [...this.recorded];
  }

  ofType<T extends AgentEvent["type"]>(type: T): Extract<AgentEvent, { type: T }>[] {
    return this.recorded
      .map((r) => r.event)
      .filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
  }

  /** Re-emit everything recorded, in order, into a listener. */
  replay(listener: AgentEventListener): void {
    for (const { event } of this.recorded) listener(event);
  }

  reset(): void {
    this.recorded = [];
  }
}

/** Convenience: start recording a bus in one line. */
export function recordEvents(bus: EventBus, now?: () => number): EventRecorder {
  return new EventRecorder(bus, now);
}

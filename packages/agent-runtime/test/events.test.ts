import { describe, expect, it, vi } from "vitest";
import { EventBus, EventRecorder, recordEvents } from "../src/index.js";

describe("EventBus", () => {
  it("delivers to every listener and unsubscribes the one that asked", () => {
    const bus = new EventBus();
    const a: string[] = [];
    const b: string[] = [];
    const offA = bus.on((e) => a.push(e.type));
    bus.on((e) => b.push(e.type));

    bus.emit({ type: "error", message: "one" });
    offA();
    bus.emit({ type: "error", message: "two" });

    expect(a).toEqual(["error"]);
    expect(b).toEqual(["error", "error"]);
    expect(bus.count()).toBe(1);
  });

  it("unsubscribing twice is harmless, and the same function may subscribe twice", () => {
    const bus = new EventBus();
    const seen: number[] = [];
    const listener = () => seen.push(1);
    const off1 = bus.on(listener);
    const off2 = bus.on(listener);
    // A Set means the second registration is the same entry — so one unsubscribe removes it, and
    // the second is a no-op rather than an error.
    off1();
    off2();
    bus.emit({ type: "error", message: "x" });
    expect(seen).toEqual([]);
  });

  it("a throwing listener does not stop the others, or the emitter", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on(() => {
      throw new Error("pane exploded");
    });
    bus.on((e) => seen.push(e.type));
    expect(() => bus.emit({ type: "agent_message", text: "hi", final: true })).not.toThrow();
    expect(seen).toEqual(["agent_message"]);
  });

  it("clear() drops everyone", () => {
    const bus = new EventBus();
    bus.on(() => {});
    bus.clear();
    expect(bus.count()).toBe(0);
  });
});

describe("EventRecorder", () => {
  it("records, filters by type and replays in order", () => {
    const bus = new EventBus();
    const clock = vi.fn(() => 1000);
    const recorder = recordEvents(bus, clock);

    bus.emit({ type: "tool_started", callId: "1", name: "read", args: { path: "a" } });
    bus.emit({ type: "tool_completed", callId: "1", name: "read", output: "x", ms: 3 });
    bus.emit({ type: "agent_message", text: "done", final: true });

    expect(recorder.events().map((e) => e.type)).toEqual(["tool_started", "tool_completed", "agent_message"]);
    expect(recorder.ofType("tool_completed")[0].output).toBe("x");
    expect(recorder.timeline()[0].at).toBe(1000);

    const replayed: string[] = [];
    recorder.replay((e) => replayed.push(e.type));
    expect(replayed).toEqual(["tool_started", "tool_completed", "agent_message"]);
  });

  it("stops, re-attaches and resets", () => {
    const bus = new EventBus();
    const recorder = new EventRecorder(bus);
    bus.emit({ type: "error", message: "one" });
    recorder.stop();
    bus.emit({ type: "error", message: "two" });
    expect(recorder.events()).toHaveLength(1);

    recorder.attach(bus);
    bus.emit({ type: "error", message: "three" });
    expect(recorder.events()).toHaveLength(2);

    recorder.reset();
    expect(recorder.events()).toEqual([]);
  });

  it("can be built without a bus and attached later", () => {
    const recorder = new EventRecorder();
    const bus = new EventBus();
    recorder.attach(bus);
    bus.emit({ type: "file_changed", path: "workspace/a.md", op: "write" });
    expect(recorder.ofType("file_changed")).toHaveLength(1);
  });
});

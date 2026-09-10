// The live transfer's framework-free half — docs/HANDOFF-infinite-agent.md §7.1.
//
// It lives in @00/agent-fs and not in the PWA because THREE hosts run it: the PWA (both ends), the
// 00 web UI inside the Mac's WKWebView (the receiving end, handing the bytes to the engine's import
// door), and a phone browser. The bundle these modules move is this package's `.00agent`, and the
// secret they derive is the one `exportBundle`/`importBundleInto` take — so this is where it belongs.
//
// Nothing here knows what a room is, what an SFU is, or what a component is. The transport is the
// `TransferChannel` interface of wire.ts, which `apps/infinite/src/transfer/sfu.ts` implements over
// WebRTC and every test implements with an array.

export * from "./wire.js";
export * from "./crypto.js";
export * from "./stream.js";

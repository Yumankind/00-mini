/**
 * The frame protocol — re-exported, not re-implemented.
 *
 * The wire lives in `@00/agent-fs` (`src/transfer/wire.ts`) because three hosts speak it: this PWA,
 * the 00 web UI inside the Mac's WKWebView, and a phone browser. This file exists so that everything
 * about the live transfer can be read from one folder, and so that a second implementation cannot
 * quietly appear here — there is nothing to edit.
 */
export {
  BUFFER_HIGH_WATER,
  BUFFER_LOW_WATER,
  CHUNK_BYTES,
  ChunkAssembler,
  WireError,
  chunkCount,
  decodeChunk,
  decodeControl,
  encodeChunk,
  encodeControl,
  readFrame,
  sendChunks,
} from "@00/agent-fs";
export type {
  AbortFrame,
  AbortReason,
  AckFrame,
  ChunkFrame,
  ControlFrame,
  DoneFrame,
  HelloFrame,
  ReadyFrame,
  TransferChannel,
} from "@00/agent-fs";

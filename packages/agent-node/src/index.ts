// @00/agent-node — the "own WebContainers" layers of docs/HANDOFF-infinite-agent.md (review item 15).
//
// Four layers, each usable on its own:
//   src/modules/  Node's core modules over this runtime's filesystem, crypto and streams
//   src/loader/   require() with Node's resolution algorithm, and ESM through a transform
//   src/fs/       the Node fs surface over AgentFs, plus the SharedArrayBuffer channel sync needs
//   src/process/  a process is a Worker; ProcessManager is the table of them
//   src/npm/      an npm client over the public registry, which answers a browser directly
//
// README.md in this package is the integration recipe. Every module states in its own header what
// it does and does not do; nothing here is a silent approximation.

export * from "./errors.js";
export * from "./paths.js";

export * from "./fs/sync-channel.js";
export * from "./fs/backend.js";

export { builtinModule, BUILTIN_NAMES, makeConsole, type BuiltinContext } from "./modules/index.js";
export { createProcess, ExitSignal, type NodeProcess, type NodeProcessOptions, type WritableSink } from "./modules/process.js";
export { bufferModule, eventsModule, pathModule, streamModule, stringDecoderModule, utilModule, deepStrictEqual, Buffer, EventEmitter, StringDecoder } from "./modules/core.js";
export { assertModule, AssertionError, osModule, querystringModule, timersModule, urlModule, fileURLToPath, pathToFileURL } from "./modules/small.js";
export { cryptoModule, Hash, Hmac, randomBytes, md5, sha1, bytesToHex, hexToBytes, bytesToBase64, base64ToBytes, HASH_BUFFER_LIMIT } from "./modules/crypto.js";
export { zlibModule, compress, decompress, sniffFormat, type SyncCompressor } from "./modules/zlib.js";
export { fsModule, makeStats, type FsModules } from "./modules/fs.js";
export {
  httpModule,
  guessContentType,
  makeIncoming,
  ServerResponse,
  STATUS_CODES,
  type BridgeRequest,
  type BridgeResponse,
  type HttpBridge,
  type NetworkBridge,
  type HttpModuleOptions,
} from "./modules/http.js";
export { netModule, tlsModule, dgramModule, dnsModule, clusterModule } from "./modules/refusals.js";
export { childProcessModule, workerThreadsModule, splitCommandLine } from "./modules/child.js";

export {
  createLoader,
  snapshotLoaderFs,
  backendLoaderFs,
  type CreateLoaderOptions,
  type Loader,
  type LoaderFs,
  type NodeModule,
  type RequireFunction,
} from "./loader/index.js";
export {
  resolveRequest,
  resolveExports,
  nodeModulesPaths,
  splitBareRequest,
  applyBrowserMap,
  findPackageDir,
  EMPTY_MODULE,
  EXTENSIONS,
  type ResolveHost,
} from "./loader/resolve.js";
export { transformEsm, hasEsmSyntax, maskSource, type TransformResult } from "./loader/esm.js";

export {
  ChildProcess,
  ProcessManager,
  DEFAULT_MAX_PROCESSES,
  type ProcessSpec,
  type ProcessWorker,
  type WorkerFactory,
  type SpawnOptions,
  type StdioValue,
  type FromWorker,
  type ToWorker,
  type ProcessManagerOptions,
} from "./process/manager.js";
export {
  serveProcess,
  createInlineWorkerFactory,
  decodeChunk,
  type WorkerChannel,
  type ProcessIo,
  type ProcessRuntimeOptions,
} from "./process/runner.js";

export {
  RegistryClient,
  DEFAULT_REGISTRY,
  ABBREVIATED_ACCEPT,
  verifyIntegrity,
  verifyShasum,
  assertSupportedRange,
  integrityBytes,
  type FetchLike,
  type Packument,
  type PackageVersion,
  type RegistryOptions,
} from "./npm/registry.js";
export {
  resolveTree,
  buildLockfile,
  buildHiddenLockfile,
  hoistCandidates,
  readJsonFile,
  type Lockfile,
  type LockPackage,
  type Placement,
  type ResolveTreeOptions,
  type ResolveTreeResult,
} from "./npm/tree.js";
export { install, writeBinShims, stripTarballPrefix, DEFAULT_CONCURRENCY, type InstallOptions, type InstallResult } from "./npm/install.js";
export {
  npmRunPlan,
  npmLs,
  rewriteBinArgv,
  binDirectories,
  readManifest,
  type RunPlan,
  type RunStep,
  type LsResult,
  type LsEntry,
  type ArgvRewrite,
  type PackageManifest,
} from "./npm/scripts.js";

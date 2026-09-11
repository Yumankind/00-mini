/**
 * `net`, `tls`, `dgram`, `dns` and `cluster` — the modules that refuse, and refuse by name.
 *
 * WHY A MODULE OF REFUSALS RATHER THAN NOTHING. `require("net")` returning `undefined` produces
 * `Cannot read properties of undefined (reading 'createConnection')` three frames into somebody
 * else's library, and a person reading that has no idea a browser is the reason. So each of these
 * resolves to a real object whose every function throws one sentence: there is no TCP in a tab, no
 * polyfill can invent one, and the roads that DO exist are `fetch` outbound and a virtual port
 * inbound. `dns` is separate only because its sentence is different: a browser resolves names
 * inside `fetch` and exposes no resolver to script at all.
 *
 * DOES: exist, name itself, and carry the constants a module might read at import time
 * (`net.isIP`, `dns.ADDRCONFIG`) so the refusal happens at CALL time, where the stack points at the
 * caller — not at import time, where it would take out a whole dependency tree over a feature the
 * caller may never use.
 *
 * DOES NOT: pretend. There is no `net.Socket` over WebSocket here. A host that wants one can build
 * it on its own relay and hand it in as a builtin override (`createLoader({ builtins })`), which is
 * exactly how the Mac-backed roads are meant to arrive.
 */

import { failNoSockets, NodeCompatError } from "../errors.js";

function refusing(module: string, names: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  const api: Record<string, unknown> = { ...extra };
  for (const name of names) api[name] = (): never => failNoSockets(`${module}.${name}`);
  api.default = api;
  return api;
}

export function netModule(): Record<string, unknown> {
  return refusing("net", ["createServer", "createConnection", "connect", "Socket", "Server"], {
    isIP: (input: string): number => (/^\d{1,3}(\.\d{1,3}){3}$/.test(input) ? 4 : input.includes(":") ? 6 : 0),
    isIPv4: (input: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(input),
    isIPv6: (input: string): boolean => input.includes(":"),
  });
}

export function tlsModule(): Record<string, unknown> {
  return refusing("tls", ["connect", "createServer", "createSecureContext", "TLSSocket"], {
    // A browser's trust store is the browser's; a script cannot read it and must not be told it can.
    rootCertificates: [],
    DEFAULT_MIN_VERSION: "TLSv1.2",
  });
}

export function dgramModule(): Record<string, unknown> {
  return refusing("dgram", ["createSocket", "Socket"]);
}

export function clusterModule(): Record<string, unknown> {
  const api: Record<string, unknown> = {
    isPrimary: true,
    isMaster: true,
    isWorker: false,
    workers: {},
    fork: (): never => {
      throw new NodeCompatError(
        "ERR_NO_CLUSTER",
        "cluster.fork: a cluster forks processes that share a listening socket, and there is neither a fork nor a socket here — child_process.fork() gives you a Worker, and the host routes one virtual port",
      );
    },
  };
  api.default = api;
  return api;
}

const DNS_WHY =
  "a browser resolves names inside fetch and exposes no resolver to script — there is no way to " +
  "look a name up without also fetching it, and this runtime will not pretend otherwise";

export function dnsModule(): Record<string, unknown> {
  const refuse =
    (name: string) =>
    (): never => {
      throw new NodeCompatError("ERR_NO_DNS", `dns.${name}: ${DNS_WHY}`);
    };
  const names = ["lookup", "resolve", "resolve4", "resolve6", "resolveMx", "resolveTxt", "resolveSrv", "reverse", "lookupService"];
  const api: Record<string, unknown> = {
    ADDRCONFIG: 32,
    V4MAPPED: 8,
    ALL: 16,
    NODATA: "ENODATA",
    NOTFOUND: "ENOTFOUND",
    getServers: (): string[] => [],
    setServers: refuse("setServers"),
    Resolver: class Resolver {
      constructor() {
        throw new NodeCompatError("ERR_NO_DNS", `new dns.Resolver: ${DNS_WHY}`);
      }
    },
  };
  for (const name of names) api[name] = refuse(name);
  api.promises = Object.fromEntries(names.map((name) => [name, refuse(name)]));
  api.default = api;
  return api;
}

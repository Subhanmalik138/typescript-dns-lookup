#!/usr/bin/env node
/**
 * dns-lookup CLI.
 *
 * Usage:
 *   dns-lookup <name> [type] [--server <ip>] [--port <n>] [--json]
 *              [--no-cache] [--timeout <ms>] [--all]
 *
 * Examples:
 *   dns-lookup example.com
 *   dns-lookup example.com MX --json
 *   dns-lookup example.com --all --server 1.1.1.1
 */
import { DnsClient } from "./client.js";
import { RECORD_TYPES, type RecordTypeName } from "./types.js";

const TYPES = Object.keys(RECORD_TYPES) as RecordTypeName[];
const ALL_TYPES: RecordTypeName[] = ["A", "AAAA", "NS", "CNAME", "MX", "TXT", "PTR", "SOA"];

function usage(): string {
  return [
    "Usage: dns-lookup <name> [type] [options]",
    "",
    "  <name>              domain name to look up (e.g. example.com)",
    "  [type]              record type: A, AAAA, NS, CNAME, MX, TXT, PTR, SOA (default: A)",
    "",
    "Options:",
    "  --server <ip>       DNS server to query (repeatable; default: system resolvers)",
    "  --port <n>          server port (default: 53)",
    "  --timeout <ms>      per-attempt timeout in ms (default: 2000)",
    "  --all               query A, AAAA, NS, CNAME, MX, TXT, PTR and SOA",
    "  --json              print machine-readable JSON instead of human-readable lines",
    "  --no-cache          skip the TTL cache (always query the server)",
    "  --help              show this help",
  ].join("\n");
}

interface CliOptions {
  name: string;
  types: RecordTypeName[];
  servers?: string[] | undefined;
  port: number;
  timeoutMs: number;
  json: boolean;
  useCache: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const positional: string[] = [];
  const servers: string[] = [];
  let port = 53;
  let timeoutMs = 2000;
  let json = false;
  let useCache = true;
  let all = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const takeValue = (flag: string): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      return value;
    };
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--server") {
      servers.push(takeValue("--server"));
    } else if (arg === "--port") {
      port = Number.parseInt(takeValue("--port"), 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("--port must be an integer between 1 and 65535");
      }
    } else if (arg === "--timeout") {
      timeoutMs = Number.parseInt(takeValue("--timeout"), 10);
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error("--timeout must be a positive integer (ms)");
      }
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--no-cache") {
      useCache = false;
    } else if (arg === "--all") {
      all = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length === 0) {
    throw new Error("missing domain name\n\n" + usage());
  }
  if (positional.length > 2) {
    throw new Error(`too many arguments: ${positional.slice(2).join(" ")}\n\n${usage()}`);
  }

  const name = positional[0] as string;
  let types: RecordTypeName[];
  if (all) {
    types = ALL_TYPES;
  } else if (positional.length === 2) {
    const type = (positional[1] as string).toUpperCase();
    if (!(TYPES as string[]).includes(type)) {
      throw new Error(`unsupported record type: ${type} (supported: ${TYPES.join(", ")})`);
    }
    types = [type as RecordTypeName];
  } else {
    types = ["A"];
  }

  return {
    name,
    types,
    servers: servers.length > 0 ? servers : undefined,
    port,
    timeoutMs,
    json,
    useCache,
  };
}

async function main(argv: string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    return 2;
  }

  const client = new DnsClient({
    servers: options.servers,
    port: options.port,
    timeoutMs: options.timeoutMs,
    cache: options.useCache ? undefined : null,
  });

  const results = await client.lookupAll(options.name, options.types);
  const sections = options.types.map((type) => {
    const result = results[type];
    if (!result) throw new Error(`internal error: no result for ${type}`);
    return {
      name: options.name,
      type,
      server: result.server,
      fromCache: result.fromCache,
      rttMs: result.rttMs ?? null,
      records: result.records.map((r) => ({ name: r.name, ttl: r.ttl, data: r.data })),
    };
  });

  if (options.json) {
    console.log(JSON.stringify(options.types.length === 1 ? sections[0] : sections, null, 2));
    return 0;
  }

  for (const section of sections) {
    const source = section.fromCache
      ? "cache"
      : `server ${section.server}${section.rttMs !== null ? ` (${section.rttMs} ms)` : ""}`;
    console.log(`; ${section.name} ${section.type} — via ${source}`);
    if (section.records.length === 0) {
      console.log(`; no ${section.type} records found`);
    }
    for (const record of section.records) {
      console.log(`${record.name}\t${record.ttl}\tIN\t${section.type}\t${record.data}`);
    }
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);

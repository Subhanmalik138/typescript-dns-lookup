/**
 * TTL-aware in-memory cache for DNS answers.
 *
 * A cached entry lives until the shortest TTL of its records expires, so
 * the cache can never serve a record past the lifetime the zone owner set.
 * The clock is injectable so expiry is testable without sleeping.
 */
import type { DnsRecord } from "./types.js";

export interface CacheEntry {
  records: DnsRecord[];
  /** Epoch milliseconds at which the entry must stop being served. */
  expiresAt: number;
}

export interface CacheOptions {
  /** Hard cap on how long any entry may live, even with a huge TTL. */
  maxTtlSeconds?: number;
  now?: () => number;
}

const DEFAULT_MAX_TTL_SECONDS = 86_400; // one day

export class DnsCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxTtlSeconds: number;
  private readonly now: () => number;

  constructor(options: CacheOptions = {}) {
    this.maxTtlSeconds = options.maxTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS;
    this.now = options.now ?? Date.now;
  }

  static key(name: string, type: number): string {
    return `${name.toLowerCase()}|${type}`;
  }

  /** Store records; the entry TTL is the minimum record TTL, capped. */
  set(name: string, type: number, records: DnsRecord[]): void {
    if (records.length === 0) return;
    const minTtl = Math.min(...records.map((r) => r.ttl));
    if (minTtl <= 0) return; // TTL 0 means "do not cache".
    const ttlSeconds = Math.min(minTtl, this.maxTtlSeconds);
    this.entries.set(DnsCache.key(name, type), {
      records,
      expiresAt: this.now() + ttlSeconds * 1000,
    });
  }

  /** Return cached records, or undefined on a miss or after expiry. */
  get(name: string, type: number): DnsRecord[] | undefined {
    const entry = this.entries.get(DnsCache.key(name, type));
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(DnsCache.key(name, type));
      return undefined;
    }
    return entry.records;
  }

  /** Seconds until the entry expires, or undefined when absent/expired. */
  ttlRemaining(name: string, type: number): number | undefined {
    const entry = this.entries.get(DnsCache.key(name, type));
    if (!entry) return undefined;
    const remaining = (entry.expiresAt - this.now()) / 1000;
    return remaining > 0 ? remaining : undefined;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

const DEFAULT_MAX_TTL_SECONDS = 86_400; // one day
export class DnsCache {
    entries = new Map();
    maxTtlSeconds;
    now;
    constructor(options = {}) {
        this.maxTtlSeconds = options.maxTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS;
        this.now = options.now ?? Date.now;
    }
    static key(name, type) {
        return `${name.toLowerCase()}|${type}`;
    }
    /** Store records; the entry TTL is the minimum record TTL, capped. */
    set(name, type, records) {
        if (records.length === 0)
            return;
        const minTtl = Math.min(...records.map((r) => r.ttl));
        if (minTtl <= 0)
            return; // TTL 0 means "do not cache".
        const ttlSeconds = Math.min(minTtl, this.maxTtlSeconds);
        this.entries.set(DnsCache.key(name, type), {
            records,
            expiresAt: this.now() + ttlSeconds * 1000,
        });
    }
    /** Return cached records, or undefined on a miss or after expiry. */
    get(name, type) {
        const entry = this.entries.get(DnsCache.key(name, type));
        if (!entry)
            return undefined;
        if (this.now() >= entry.expiresAt) {
            this.entries.delete(DnsCache.key(name, type));
            return undefined;
        }
        return entry.records;
    }
    /** Seconds until the entry expires, or undefined when absent/expired. */
    ttlRemaining(name, type) {
        const entry = this.entries.get(DnsCache.key(name, type));
        if (!entry)
            return undefined;
        const remaining = (entry.expiresAt - this.now()) / 1000;
        return remaining > 0 ? remaining : undefined;
    }
    clear() {
        this.entries.clear();
    }
    get size() {
        return this.entries.size;
    }
}

import assert from "node:assert/strict";
import test from "node:test";
import { DnsCache } from "../src/cache.js";
function record(ttl, data = "1.2.3.4") {
    return { name: "example.com.", type: 1, typeName: "A", ttl, data, raw: Buffer.alloc(0) };
}
test("cache returns records before expiry and misses after", () => {
    let now = 1_000_000;
    const cache = new DnsCache({ now: () => now });
    cache.set("example.com", 1, [record(300)]);
    assert.deepEqual(cache.get("example.com", 1)?.map((r) => r.data), ["1.2.3.4"]);
    assert.equal(cache.ttlRemaining("example.com", 1), 300);
    now += 299_000; // 299 seconds later: still valid
    assert.equal(cache.get("example.com", 1)?.length, 1);
    now += 2_000; // 301 seconds later: expired
    assert.equal(cache.get("example.com", 1), undefined);
    assert.equal(cache.ttlRemaining("example.com", 1), undefined);
});
test("cache uses the minimum record TTL and ignores TTL 0", () => {
    let now = 0;
    const cache = new DnsCache({ now: () => now });
    cache.set("example.com", 1, [record(600), record(60, "5.6.7.8")]);
    now += 61_000;
    assert.equal(cache.get("example.com", 1), undefined);
    cache.set("example.com", 1, [record(0)]);
    assert.equal(cache.size, 0);
});
test("cache keys are case-insensitive and type-scoped", () => {
    const cache = new DnsCache();
    cache.set("Example.COM", 1, [record(300)]);
    assert.equal(cache.get("example.com", 1)?.length, 1);
    assert.equal(cache.get("example.com", 28), undefined); // different type
    cache.clear();
    assert.equal(cache.size, 0);
});
test("cache honours the max-TTL cap", () => {
    let now = 0;
    const cache = new DnsCache({ now: () => now, maxTtlSeconds: 60 });
    cache.set("example.com", 1, [record(3600)]);
    now += 61_000;
    assert.equal(cache.get("example.com", 1), undefined);
});

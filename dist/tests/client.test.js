import assert from "node:assert/strict";
import test from "node:test";
import { DnsClient } from "../src/client.js";
import { DnsError, RECORD_TYPES } from "../src/types.js";
import { decodeMessage, encodeName } from "../src/wire.js";
/**
 * A fake transport that answers every query with one canned record, or
 * NXDOMAIN when `rcode` is set. No sockets involved, so these tests run
 * anywhere — including sandboxes that block UDP.
 */
function rdataFor(type) {
    switch (type) {
        case 1:
            return Buffer.from([93, 184, 216, 34]);
        case 28:
            return Buffer.from("20010db8000000000000000000000001", "hex");
        case 16:
            return Buffer.concat([Buffer.from([5]), Buffer.from("hello")]);
        case 15:
            return Buffer.concat([Buffer.from([0x00, 0x0a]), encodeName("mail.example.com")]);
        default:
            return encodeName("example.com");
    }
}
function cannedTransport(rcode = 0) {
    let requests = 0;
    const transport = async (packet) => {
        requests++;
        const query = decodeMessage(packet);
        const q = query.questions[0];
        const header = Buffer.alloc(12);
        header.writeUInt16BE(query.id, 0);
        header.writeUInt16BE(0x8180 | rcode, 2); // response, RD+RA, rcode
        header.writeUInt16BE(1, 4);
        header.writeUInt16BE(rcode === 0 ? 1 : 0, 6);
        const question = Buffer.concat([
            encodeName(q.name),
            Buffer.from([(q.type >> 8) & 0xff, q.type & 0xff, 0x00, 0x01]),
        ]);
        let answer = Buffer.alloc(0);
        if (rcode === 0) {
            const rdata = rdataFor(q.type);
            const head = Buffer.alloc(12);
            head.writeUInt16BE(0xc00c, 0);
            head.writeUInt16BE(q.type, 2);
            head.writeUInt16BE(1, 4);
            head.writeUInt32BE(120, 6);
            head.writeUInt16BE(rdata.length, 10);
            answer = Buffer.concat([head, rdata]);
        }
        return Buffer.concat([header, question, answer]);
    };
    return { transport, requests: () => requests };
}
function clientWith(transport, extra = {}) {
    return new DnsClient({ servers: ["127.0.0.1"], timeoutMs: 1000, retries: 0, transport, ...extra });
}
test("client returns decoded records from the transport", async () => {
    const { transport } = cannedTransport();
    const client = clientWith(transport);
    const a = await client.lookup("example.com", "A");
    assert.equal(a.fromCache, false);
    assert.equal(a.records.length, 1);
    assert.equal(a.records[0].data, "93.184.216.34");
    assert.equal(a.records[0].ttl, 120);
    assert.equal(a.server, "127.0.0.1");
    assert.equal(typeof a.rttMs, "number");
    const aaaa = await client.lookup("example.com", "AAAA");
    assert.equal(aaaa.records[0].data, "2001:db8::1");
    const txt = await client.lookup("example.com", "TXT");
    assert.equal(txt.records[0].data, "hello");
    const mx = await client.lookup("example.com", "MX");
    assert.equal(mx.records[0].data, "10 mail.example.com.");
    const all = await client.lookupAll("example.com", ["A", "TXT"]);
    assert.equal(all.A.records[0].data, "93.184.216.34");
    assert.equal(all.TXT.records[0].data, "hello");
});
test("client serves the second identical lookup from cache", async () => {
    const { transport, requests } = cannedTransport();
    const client = clientWith(transport);
    await client.lookup("example.com", "A");
    assert.equal(requests(), 1);
    const cached = await client.lookup("example.com", "A");
    assert.equal(cached.fromCache, true);
    assert.equal(cached.records[0].data, "93.184.216.34");
    assert.equal(requests(), 1); // no second transport round-trip
    const noCache = clientWith(transport, { cache: null });
    await noCache.lookup("example.com", "A");
    await noCache.lookup("example.com", "A");
    assert.equal(requests(), 3);
});
test("client reports NXDOMAIN as an error", async () => {
    const { transport } = cannedTransport(3);
    const client = clientWith(transport);
    await assert.rejects(() => client.lookup("missing.example", "A"), /NXDOMAIN/);
});
test("client retries a timing-out transport, then succeeds", async () => {
    const { transport: good } = cannedTransport();
    let calls = 0;
    const flaky = async (...args) => {
        calls++;
        if (calls <= 2) {
            throw new DnsError("query to 127.0.0.1 timed out", "TIMEOUT");
        }
        return good(...args);
    };
    const client = clientWith(flaky, { retries: 2 });
    const result = await client.lookup("example.com", "A");
    assert.equal(result.records[0].data, "93.184.216.34");
    assert.equal(calls, 3);
});
test("client gives up after the configured retries", async () => {
    let calls = 0;
    const blackHole = async () => {
        calls++;
        throw new DnsError("query to 127.0.0.1 timed out", "TIMEOUT");
    };
    const client = clientWith(blackHole, { retries: 1 });
    await assert.rejects(() => client.lookup("example.com", "A"), /timed out/);
    assert.equal(calls, 2); // initial attempt + 1 retry
});
test("client skips a dead server and tries the next one", async () => {
    const { transport: good } = cannedTransport();
    const dead = async () => {
        throw new DnsError("query to 10.255.255.1 timed out", "TIMEOUT");
    };
    const picking = async (packet, server, port, timeoutMs) => server === "10.255.255.1" ? dead(packet, server, port, timeoutMs) : good(packet, server, port, timeoutMs);
    const client = new DnsClient({
        servers: ["10.255.255.1", "127.0.0.1"],
        retries: 0,
        transport: picking,
    });
    const result = await client.lookup("example.com", "A");
    assert.equal(result.records[0].data, "93.184.216.34");
    assert.equal(result.server, "127.0.0.1");
});
test("RECORD_TYPES covers the supported query types", () => {
    for (const name of ["A", "AAAA", "NS", "CNAME", "MX", "TXT", "PTR", "SOA"]) {
        assert.equal(typeof RECORD_TYPES[name], "number");
    }
});

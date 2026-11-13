/**
 * UDP DNS client: sends hand-encoded queries, decodes responses, retries
 * on timeout, and caches answers by their TTL.
 *
 * The transport is a single UDP socket per lookup (created lazily, closed
 * after the response or the last retry), which keeps concurrent lookups
 * independent and avoids leaking sockets.
 */
import * as dgram from "node:dgram";
import * as fs from "node:fs";
import { DnsCache } from "./cache.js";
import { DnsError, RCODE_NAMES, RECORD_TYPES, } from "./types.js";
import { decodeMessage, encodeQuery } from "./wire.js";
/** The default transport: one UDP socket per query, closed afterwards. */
export function createUdpTransport() {
    return (packet, server, port, timeoutMs) => new Promise((resolve, reject) => {
        const expectedId = packet.readUInt16BE(0);
        const socket = dgram.createSocket("udp4");
        let timer;
        let settled = false;
        const finish = (err, buf) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            try {
                socket.close();
            }
            catch {
                /* already closed */
            }
            if (err)
                reject(err);
            else
                resolve(buf);
        };
        socket.on("error", (err) => finish(err));
        socket.on("message", (buf) => {
            try {
                // Ignore stray packets (e.g. a late reply to an earlier query).
                if (decodeMessage(buf).id !== expectedId)
                    return;
                finish(undefined, buf);
            }
            catch (err) {
                finish(err instanceof Error ? err : new Error(String(err)));
            }
        });
        socket.send(packet, port, server, (err) => {
            if (err)
                finish(err);
        });
        timer = setTimeout(() => {
            finish(new DnsError(`query to ${server} timed out`, "TIMEOUT"));
        }, timeoutMs);
        timer.unref?.();
    });
}
const FALLBACK_SERVERS = ["8.8.8.8", "1.1.1.1"];
const DEFAULT_PORT = 53;
/** Read `nameserver` lines from /etc/resolv.conf (Linux/macOS). */
export function systemServers() {
    try {
        const text = fs.readFileSync("/etc/resolv.conf", "utf8");
        const servers = text
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.startsWith("nameserver"))
            .map((line) => line.split(/\s+/)[1])
            .filter((ip) => Boolean(ip));
        return servers.length > 0 ? servers : FALLBACK_SERVERS;
    }
    catch {
        return FALLBACK_SERVERS;
    }
}
let nextId = Math.floor(Math.random() * 0xffff);
export class DnsClient {
    servers;
    port;
    timeoutMs;
    retries;
    cache;
    transport;
    constructor(options = {}) {
        this.servers = options.servers ?? systemServers();
        this.port = options.port ?? DEFAULT_PORT;
        this.timeoutMs = options.timeoutMs ?? 2000;
        this.retries = options.retries ?? 1;
        this.cache = options.cache === undefined ? new DnsCache() : options.cache;
        this.transport = options.transport ?? createUdpTransport();
    }
    /**
     * Look up `name` for one record type. Tries each configured server in
     * order; a server that times out (after retries) is skipped, so a dead
     * first resolver does not fail the lookup outright.
     */
    async lookup(name, type) {
        const typeNum = RECORD_TYPES[type];
        const cached = this.cache?.get(name, typeNum);
        if (cached) {
            return { records: cached, fromCache: true, server: "cache" };
        }
        let lastError;
        for (const server of this.servers) {
            try {
                const started = Date.now();
                const message = await this.queryServer(server, name, type);
                const rttMs = Date.now() - started;
                if (message.rcode !== 0) {
                    const label = RCODE_NAMES[message.rcode] ?? `RCODE ${message.rcode}`;
                    throw new DnsError(`server ${server} refused the query for ${name} (${label})`, "SERVER_ERROR");
                }
                if (message.truncated) {
                    throw new DnsError("response truncated (TC bit set); TCP fallback not implemented", "TRUNCATED");
                }
                this.cache?.set(name, typeNum, message.answers);
                return { records: message.answers, fromCache: false, rttMs, server };
            }
            catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
            }
        }
        throw lastError ?? new DnsError("no DNS servers configured", "NO_SERVERS");
    }
    /** Look up several types in parallel; results are keyed by type name. */
    async lookupAll(name, types) {
        const entries = await Promise.all(types.map(async (type) => [type, await this.lookup(name, type)]));
        return Object.fromEntries(entries);
    }
    /**
     * Send one query to one server, retrying with a fresh transaction ID
     * after each timeout, and return the decoded message.
     */
    async queryServer(server, name, type) {
        let lastError;
        for (let attempt = 0; attempt <= this.retries; attempt++) {
            const id = (nextId = (nextId + 1) & 0xffff);
            let packet;
            try {
                packet = encodeQuery(id, name, type);
            }
            catch (err) {
                // A malformed name will never succeed: fail fast, no retries.
                throw err instanceof Error ? err : new Error(String(err));
            }
            try {
                const raw = await this.transport(packet, server, this.port, this.timeoutMs);
                return decodeMessage(raw);
            }
            catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
            }
        }
        throw lastError ?? new DnsError("no DNS servers configured", "NO_SERVERS");
    }
}

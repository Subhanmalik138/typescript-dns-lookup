/**
 * Real-UDP integration tests: the client against an in-process mock DNS
 * server over actual datagrams.
 *
 * Skipped by default — some sandboxes block outbound UDP (EPERM on
 * send). Run with DNS_INTEGRATION=1 on a machine with normal networking:
 *
 *   DNS_INTEGRATION=1 npm test
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as dgram from "node:dgram";
import * as path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DnsClient } from "../src/client.js";
import { decodeMessage, encodeName } from "../src/wire.js";
const execFileAsync = promisify(execFile);
const CLI = path.join(process.cwd(), "dist", "src", "cli.js");
const maybe = process.env.DNS_INTEGRATION ? test : test.skip;
async function startMockServer() {
    const socket = dgram.createSocket("udp4");
    socket.on("message", (msg, rinfo) => {
        const query = decodeMessage(msg);
        const q = query.questions[0];
        const header = Buffer.alloc(12);
        header.writeUInt16BE(query.id, 0);
        header.writeUInt16BE(0x8180, 2);
        header.writeUInt16BE(1, 4);
        header.writeUInt16BE(1, 6);
        const question = Buffer.concat([
            encodeName(q.name),
            Buffer.from([(q.type >> 8) & 0xff, q.type & 0xff, 0x00, 0x01]),
        ]);
        const rdata = Buffer.from([93, 184, 216, 34]);
        const head = Buffer.alloc(12);
        head.writeUInt16BE(0xc00c, 0);
        head.writeUInt16BE(q.type, 2);
        head.writeUInt16BE(1, 4);
        head.writeUInt32BE(300, 6);
        head.writeUInt16BE(rdata.length, 10);
        socket.send(Buffer.concat([header, question, head, rdata]), rinfo.port, rinfo.address);
    });
    await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
    return {
        port: socket.address().port,
        close: () => new Promise((resolve) => socket.close(() => resolve())),
    };
}
maybe("client resolves over real UDP against a mock server", async () => {
    const server = await startMockServer();
    try {
        const client = new DnsClient({
            servers: ["127.0.0.1"],
            port: server.port,
            timeoutMs: 1000,
            retries: 0,
        });
        const result = await client.lookup("example.com", "A");
        assert.equal(result.records[0].data, "93.184.216.34");
        assert.equal(result.fromCache, false);
    }
    finally {
        await server.close();
    }
});
maybe("client times out over real UDP when the server never answers", async () => {
    const blackHole = dgram.createSocket("udp4");
    await new Promise((resolve) => blackHole.bind(0, "127.0.0.1", resolve));
    const port = blackHole.address().port;
    try {
        const client = new DnsClient({
            servers: ["127.0.0.1"],
            port,
            timeoutMs: 100,
            retries: 0,
        });
        await assert.rejects(() => client.lookup("example.com", "A"), /timed out/);
    }
    finally {
        await new Promise((resolve) => blackHole.close(() => resolve()));
    }
});
async function runCli(args) {
    try {
        const { stdout, stderr } = await execFileAsync("node", [CLI, ...args], {
            timeout: 10_000,
        });
        return { code: 0, stdout, stderr };
    }
    catch (err) {
        const e = err;
        return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
}
maybe("CLI prints human-readable answers over real UDP", async () => {
    const server = await startMockServer();
    try {
        const { code, stdout } = await runCli([
            "example.com",
            "A",
            "--server",
            "127.0.0.1",
            "--port",
            String(server.port),
            "--no-cache",
        ]);
        assert.equal(code, 0);
        assert.match(stdout, /example\.com\.\t300\tIN\tA\t93\.184\.216\.34/);
    }
    finally {
        await server.close();
    }
});
maybe("CLI --json prints structured output over real UDP", async () => {
    const server = await startMockServer();
    try {
        const { code, stdout } = await runCli([
            "example.com",
            "--server",
            "127.0.0.1",
            "--port",
            String(server.port),
            "--json",
            "--no-cache",
        ]);
        assert.equal(code, 0);
        const parsed = JSON.parse(stdout);
        assert.equal(parsed.name, "example.com");
        assert.equal(parsed.type, "A");
        assert.equal(parsed.records[0].data, "93.184.216.34");
    }
    finally {
        await server.close();
    }
});

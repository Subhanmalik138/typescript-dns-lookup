import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
// Tests run against the compiled CLI in dist/.
const CLI = path.join(process.cwd(), "dist", "src", "cli.js");
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
test("CLI prints help and exits 0", async () => {
    const { code, stdout } = await runCli(["--help"]);
    assert.equal(code, 0);
    assert.match(stdout, /Usage: dns-lookup/);
});
test("CLI rejects bad usage with exit code 2", async () => {
    const noArgs = await runCli([]);
    assert.equal(noArgs.code, 2);
    assert.match(noArgs.stderr, /missing domain name/);
    const badType = await runCli(["example.com", "BOGUS"]);
    assert.equal(badType.code, 2);
    assert.match(badType.stderr, /unsupported record type/);
    const badPort = await runCli(["example.com", "--port", "99999"]);
    assert.equal(badPort.code, 2);
    assert.match(badPort.stderr, /--port must be an integer/);
});

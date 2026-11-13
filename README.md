# typescript-dns-lookup

A DNS lookup CLI in TypeScript that speaks the DNS wire protocol directly —
no `dns` module, no resolver library, no runtime dependencies. It builds the
query packet by hand, sends it over UDP, decodes the response (including
name compression), and caches answers by their TTL.

```sh
$ npm run build
$ node dist/src/cli.js example.com
; example.com A — via server 8.8.8.8 (24 ms)
example.com.	300	IN	A	93.184.216.34

$ node dist/src/cli.js example.com MX --json
{
  "name": "example.com",
  "type": "MX",
  "server": "8.8.8.8",
  "fromCache": false,
  "rttMs": 21,
  "records": [
    { "name": "example.com.", "ttl": 300, "data": "0 ." }
  ]
}
```

## Why build this

Every program that touches the internet depends on DNS, and almost all of
them hide it behind a library call. Implementing RFC 1035 by hand is the
fastest way to actually understand the protocol: the 12-byte header, the
label-encoded names, the compression pointers that make responses compact,
and the TTL rules that decide how long an answer may be reused.

## Design decisions

- **Hand-rolled wire format, zero dependencies.** `src/wire.ts` is pure
  Buffer manipulation — encoding queries, decoding responses, following
  compression pointers with a loop guard. Because it never touches the
  network, it is unit-testable against hand-crafted packets byte for byte.
- **Transport is injectable.** `DnsClient` takes a `DnsTransport`
  (`(packet, server, port, timeoutMs) => Promise<Buffer>`); the default is
  UDP via `node:dgram`. Tests inject a fake transport, so the whole client
  — retries, failover, caching — is covered without a socket. The real-UDP
  path is covered by integration tests gated behind `DNS_INTEGRATION=1`.
- **TTL is a contract, not a hint.** The cache stores an answer only until
  the shortest TTL of its records expires, caps TTLs at one day, and never
  caches TTL-0 records. A second lookup for the same name/type is served
  from cache with no network round-trip.
- **Failover, not fail-fast.** A server that times out is retried, then
  skipped in favour of the next configured resolver. Servers default to
  `/etc/resolv.conf`, falling back to 8.8.8.8 and 1.1.1.1.

## Usage

```sh
npm install
npm run build

# A record (default type)
node dist/src/cli.js example.com

# Any supported type: A, AAAA, NS, CNAME, MX, TXT, PTR, SOA
node dist/src/cli.js example.com MX
node dist/src/cli.js example.com TXT --json

# Everything at once
node dist/src/cli.js example.com --all

# Pick a resolver, skip the cache
node dist/src/cli.js example.com --server 1.1.1.1 --no-cache
```

Exit codes: `0` success, `1` lookup failure (timeout, NXDOMAIN, refused),
`2` usage error.

## Library use

```ts
import { DnsClient } from "typescript-dns-lookup";

const client = new DnsClient({ servers: ["1.1.1.1"], timeoutMs: 2000 });
const { records, fromCache, rttMs } = await client.lookup("example.com", "A");
const all = await client.lookupAll("example.com", ["A", "AAAA", "MX"]);
```

## Tests

```sh
npm test            # 20 unit tests (node:test, no network needed)
DNS_INTEGRATION=1 npm test   # + 4 real-UDP integration tests
npm run typecheck   # strict tsc --noEmit
```

The wire decoder is tested against hand-written response packets (including
a compression-pointer loop, which must be rejected), the cache against a
fake clock, and the client against a fake transport that counts requests —
so caching, retries, failover, and NXDOMAIN handling are all verified
without touching the network.

## Tech stack

- TypeScript 5 (strict mode, `noUncheckedIndexedAccess`)
- Node.js ≥ 22 (UDP via `node:dgram`, tests via `node:test`)
- Zero runtime dependencies

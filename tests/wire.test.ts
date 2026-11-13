import assert from "node:assert/strict";
import test from "node:test";
import { DnsError } from "../src/types.js";
import {
  decodeMessage,
  encodeName,
  encodeQuery,
  formatIPv6,
  splitLabels,
} from "../src/wire.js";

/**
 * A hand-built response for example.com, written byte-by-byte so the
 * decoder is tested against literal wire bytes, not its own encoder:
 *
 *   header: id 0x1234, flags 0x8180 (response, RD+RA, NOERROR),
 *           QD=1, AN=2, NS=0, AR=0
 *   question: example.com, A, IN
 *   answer 1: <ptr to qname> A IN TTL 300 -> 93.184.216.34
 *   answer 2: <ptr to qname> CNAME IN TTL 600 -> alias.example.com.
 */
function craftedResponse(): Buffer {
  const header = Buffer.from([
    0x12, 0x34, 0x81, 0x80, 0x00, 0x01, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00,
  ]);
  const question = Buffer.concat([
    Buffer.from([7, ...Buffer.from("example"), 3, ...Buffer.from("com"), 0]),
    Buffer.from([0x00, 0x01, 0x00, 0x01]),
  ]);
  const answerA = Buffer.from([
    0xc0, 0x0c, // name: compression pointer to offset 12
    0x00, 0x01, // type A
    0x00, 0x01, // class IN
    0x00, 0x00, 0x01, 0x2c, // TTL 300
    0x00, 0x04, // RDLENGTH 4
    93, 184, 216, 34,
  ]);
  const answerCname = Buffer.concat([
    Buffer.from([
      0xc0, 0x0c, // name: pointer to offset 12
      0x00, 0x05, // type CNAME
      0x00, 0x01, // class IN
      0x00, 0x00, 0x02, 0x58, // TTL 600
      0x00, 0x08, // RDLENGTH 8
      0x05, ...Buffer.from("alias"), 0xc0, 0x0c, // "alias" + pointer to example.com
    ]),
  ]);
  return Buffer.concat([header, question, answerA, answerCname]);
}

test("encodeQuery builds a valid query header and question", () => {
  const packet = encodeQuery(0xabcd, "example.com", "A");
  assert.equal(packet.readUInt16BE(0), 0xabcd);
  assert.equal(packet.readUInt16BE(2), 0x0100); // RD set
  assert.equal(packet.readUInt16BE(4), 1); // QDCOUNT
  assert.equal(packet.readUInt16BE(6), 0); // ANCOUNT
  const decoded = decodeMessage(packet);
  assert.equal(decoded.isResponse, false);
  assert.equal(decoded.questions.length, 1);
  assert.equal(decoded.questions[0]!.name, "example.com.");
  assert.equal(decoded.questions[0]!.type, 1);
});

test("decodeMessage resolves compression pointers and parses rdata", () => {
  const msg = decodeMessage(craftedResponse());
  assert.equal(msg.id, 0x1234);
  assert.equal(msg.isResponse, true);
  assert.equal(msg.recursionAvailable, true);
  assert.equal(msg.rcode, 0);
  assert.equal(msg.questions[0]!.name, "example.com.");
  assert.equal(msg.answers.length, 2);

  const [a, cname] = msg.answers;
  assert.ok(a);
  assert.ok(cname);
  assert.equal(a.name, "example.com.");
  assert.equal(a.typeName, "A");
  assert.equal(a.ttl, 300);
  assert.equal(a.data, "93.184.216.34");
  assert.deepEqual(Array.from(a.raw), [93, 184, 216, 34]);

  assert.equal(cname.typeName, "CNAME");
  assert.equal(cname.ttl, 600);
  assert.equal(cname.data, "alias.example.com.");
});

test("encodeName handles the root and trailing dots", () => {
  assert.deepEqual(Array.from(encodeName(".")), [0]);
  assert.deepEqual(Array.from(encodeName("example.com.")), [
    7, ...Buffer.from("example"), 3, ...Buffer.from("com"), 0,
  ]);
});

test("splitLabels rejects malformed names", () => {
  assert.throws(() => splitLabels("a..b"), DnsError);
  assert.throws(() => splitLabels("x".repeat(64) + ".com"), DnsError);
  assert.throws(() => splitLabels("bad name.com"), DnsError);
  assert.throws(() => splitLabels(`${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.com`), DnsError);
});

test("decodeMessage rejects truncated and looping packets", () => {
  assert.throws(() => decodeMessage(Buffer.alloc(5)), /truncated/);
  assert.throws(() => decodeMessage(craftedResponse().subarray(0, 30)), /truncated/);

  // Question name is a pointer to its own offset (12) — a loop.
  const loop = Buffer.from([
    0x00, 0x01, 0x81, 0x80, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01,
  ]);
  assert.throws(() => decodeMessage(loop), /loop|indirection/);
});

test("formatIPv6 collapses the longest zero run", () => {
  assert.equal(
    formatIPv6(Buffer.from("20010db8000000000000000000000001", "hex")),
    "2001:db8::1",
  );
  assert.equal(
    formatIPv6(Buffer.from("00000000000000000000000000000001", "hex")),
    "::1",
  );
  assert.equal(
    formatIPv6(Buffer.from("20010db800000000000000ff00004283", "hex")),
    "2001:db8::ff:0:4283",
  );
  // No run of two or more zeros: no compression.
  assert.equal(
    formatIPv6(Buffer.from("20010db8000100020003000400050006", "hex")),
    "2001:db8:1:2:3:4:5:6",
  );
});

test("decodeMessage parses AAAA, MX, TXT and SOA rdata", () => {
  const question = Buffer.concat([
    encodeName("example.com"),
    Buffer.from([0x00, 0x01, 0x00, 0x01]),
  ]);
  const buildRecord = (type: number, ttl: number, rdata: Buffer): Buffer => {
    // Record header: name(2) type(2) class(2) ttl(4) rdlength(2) = 12 bytes.
    const head = Buffer.alloc(12);
    head.writeUInt16BE(0xc00c, 0); // name pointer
    head.writeUInt16BE(type, 2);
    head.writeUInt16BE(1, 4);
    head.writeUInt32BE(ttl, 6);
    head.writeUInt16BE(rdata.length, 10);
    return Buffer.concat([head, rdata]);
  };
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x7777, 0);
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(4, 6);

  const aaaa = Buffer.from("20010db8000000000000000000000001", "hex");
  const mx = Buffer.concat([
    Buffer.from([0x00, 0x0a]),
    encodeName("mail.example.com"),
  ]);
  const txt = Buffer.concat([Buffer.from([5]), Buffer.from("hello")]);
  const soa = Buffer.concat([
    encodeName("ns.example.com"),
    encodeName("hostmaster.example.com"),
    Buffer.from([
      0x00, 0x00, 0x00, 0x01, // serial 1
      0x00, 0x00, 0x0e, 0x10, // refresh 3600
      0x00, 0x00, 0x02, 0x58, // retry 600
      0x00, 0x09, 0x3a, 0x80, // expire 604800
      0x00, 0x00, 0x0e, 0x10, // minimum 3600
    ]),
  ]);

  const packet = Buffer.concat([
    header,
    question,
    buildRecord(28, 300, aaaa),
    buildRecord(15, 300, mx),
    buildRecord(16, 60, txt),
    buildRecord(6, 3600, soa),
  ]);
  const msg = decodeMessage(packet);
  assert.equal(msg.answers[0]!.data, "2001:db8::1");
  assert.equal(msg.answers[1]!.data, "10 mail.example.com.");
  assert.equal(msg.answers[2]!.data, "hello");
  assert.equal(
    msg.answers[3]!.data,
    "ns.example.com. hostmaster.example.com. 1 3600 600 604800 3600",
  );
});

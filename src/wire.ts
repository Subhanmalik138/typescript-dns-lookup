/**
 * DNS wire-format encoding and decoding (RFC 1035 §4).
 *
 * Everything here is pure Buffer manipulation — no network access — so it
 * is fully unit-testable against hand-crafted packets.
 */
import {
  CLASS_IN,
  DnsError,
  RECORD_TYPES,
  TYPE_NAMES,
  type DnsMessage,
  type DnsRecord,
  type RecordTypeName,
} from "./types.js";

/** Validate a domain name and split it into labels. */
export function splitLabels(name: string): string[] {
  if (name === "" || name === ".") return [];
  const trimmed = name.endsWith(".") ? name.slice(0, -1) : name;
  if (trimmed.length === 0) return [];
  if (trimmed.length > 253) {
    throw new DnsError(`domain name too long (${trimmed.length} > 253 chars)`, "INVALID_NAME");
  }
  const labels = trimmed.split(".");
  for (const label of labels) {
    if (label.length === 0) {
      throw new DnsError(`empty label in domain name "${name}"`, "INVALID_NAME");
    }
    if (label.length > 63) {
      throw new DnsError(`label "${label}" too long (> 63 chars)`, "INVALID_NAME");
    }
    if (!/^[A-Za-z0-9_-]+$/.test(label)) {
      throw new DnsError(`label "${label}" contains invalid characters`, "INVALID_NAME");
    }
  }
  return labels;
}

/** Encode a domain name as length-prefixed labels ending in a zero byte. */
export function encodeName(name: string): Buffer {
  const labels = splitLabels(name);
  const parts: Buffer[] = labels.map((label) => {
    const bytes = Buffer.from(label, "ascii");
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  });
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** Encode a standard query (RD set, one question). */
export function encodeQuery(id: number, name: string, type: RecordTypeName): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id & 0xffff, 0);
  // Flags: RD (recursion desired) = 0x0100.
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4); // QDCOUNT
  const qname = encodeName(name);
  const question = Buffer.alloc(4);
  question.writeUInt16BE(RECORD_TYPES[type], 0);
  question.writeUInt16BE(CLASS_IN, 2);
  return Buffer.concat([header, qname, question]);
}

/** A cursor over a message buffer that understands compression pointers. */
class Reader {
  private pos = 0;
  /** Guards against pointer loops in hostile packets. */
  private jumps = 0;

  constructor(private readonly buf: Buffer) {}

  get offset(): number {
    return this.pos;
  }

  get length(): number {
    return this.buf.length;
  }

  private need(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new DnsError("truncated DNS message", "TRUNCATED");
    }
  }

  uint8(): number {
    this.need(1);
    const v = this.buf.readUInt8(this.pos);
    this.pos += 1;
    return v;
  }

  uint16(): number {
    this.need(2);
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }

  uint32(): number {
    this.need(4);
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  bytes(n: number): Buffer {
    this.need(n);
    const slice = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  /** Copy of bytes [start, end) without moving the cursor. */
  slice(start: number, end: number): Buffer {
    if (start < 0 || end > this.buf.length || start > end) {
      throw new DnsError("record overruns message", "TRUNCATED");
    }
    return Buffer.from(this.buf.subarray(start, end));
  }

  /**
   * Read a domain name, following compression pointers (RFC 1035 §4.1.4).
   * After a jump, reading continues from just after the pointer, so the
   * caller's position stays correct.
   */
  name(): string {
    const labels: string[] = [];
    // Where to resume reading after following a compression pointer:
    // just past the pointer itself, not past the name it points to.
    let resumePos = -1;
    let guard = 0;
    for (;;) {
      if (guard++ > 128) throw new DnsError("too many name indirections", "BAD_NAME");
      this.need(1);
      const len = this.buf.readUInt8(this.pos);
      if (len === 0) {
        this.pos += 1;
        break;
      }
      if ((len & 0xc0) === 0xc0) {
        // Compression pointer: 14-bit offset into the message.
        this.need(2);
        const target = ((len & 0x3f) << 8) | this.buf.readUInt8(this.pos + 1);
        if (resumePos === -1) resumePos = this.pos + 2;
        if (++this.jumps > 10) throw new DnsError("compression pointer loop", "BAD_NAME");
        if (target >= this.buf.length) {
          throw new DnsError("compression pointer out of bounds", "BAD_NAME");
        }
        this.pos = target;
        continue;
      }
      if (len & 0xc0) {
        throw new DnsError(`invalid label length byte 0x${len.toString(16)}`, "BAD_NAME");
      }
      this.need(1 + len);
      this.pos += 1;
      labels.push(this.buf.subarray(this.pos, this.pos + len).toString("ascii"));
      this.pos += len;
    }
    if (resumePos !== -1) this.pos = resumePos;
    return labels.length === 0 ? "." : labels.join(".") + ".";
  }
}

/** Format 16 raw bytes as an IPv6 address, collapsing the longest zero run. */
export function formatIPv6(bytes: Buffer): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push(bytes.readUInt16BE(i).toString(16));
  }
  // Find the longest run of "0" groups (length >= 2) to collapse with "::".
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i <= groups.length; i++) {
    if (i < groups.length && groups[i] === "0") {
      if (curStart === -1) {
        curStart = i;
        curLen = 1;
      } else {
        curLen++;
      }
    } else {
      if (curLen > bestLen) {
        bestStart = curStart;
        bestLen = curLen;
      }
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestLen < 2) return groups.join(":");
  const head = groups.slice(0, bestStart).join(":");
  const tail = groups.slice(bestStart + bestLen).join(":");
  return `${head}::${tail}`;
}

function parseRdata(reader: Reader, type: number, rdlength: number): string {
  const start = reader.offset;
  const end = start + rdlength;
  const slice = (): Buffer => reader.bytes(rdlength);

  switch (type) {
    case 1: {
      // A
      if (rdlength !== 4) throw new DnsError(`bad A record length ${rdlength}`, "BAD_RDATA");
      return Array.from(slice()).join(".");
    }
    case 28: {
      // AAAA
      if (rdlength !== 16) throw new DnsError(`bad AAAA record length ${rdlength}`, "BAD_RDATA");
      return formatIPv6(slice());
    }
    case 2:
    case 5:
    case 12:
      // NS / CNAME / PTR: a single domain name.
      return reader.name();
    case 15: {
      // MX: preference + exchange name.
      const preference = reader.uint16();
      return `${preference} ${reader.name()}`;
    }
    case 16: {
      // TXT: one or more length-prefixed character strings.
      const parts: string[] = [];
      while (reader.offset < end) {
        const len = reader.uint8();
        parts.push(reader.bytes(len).toString("utf8"));
      }
      return parts.join(" ");
    }
    case 6: {
      // SOA: mname, rname, then five uint32s.
      const mname = reader.name();
      const rname = reader.name();
      const serial = reader.uint32();
      const refresh = reader.uint32();
      const retry = reader.uint32();
      const expire = reader.uint32();
      const minimum = reader.uint32();
      return `${mname} ${rname} ${serial} ${refresh} ${retry} ${expire} ${minimum}`;
    }
    default: {
      // Unknown type: fall back to a hex dump so nothing is lost.
      const raw = slice();
      return raw.length === 0 ? "" : raw.toString("hex");
    }
  }
}

function readRecord(reader: Reader): DnsRecord {
  const name = reader.name();
  const type = reader.uint16();
  reader.uint16(); // class (IN expected; kept lenient for parsing)
  const ttl = reader.uint32();
  const rdlength = reader.uint16();
  const recordStart = reader.offset;
  if (recordStart + rdlength > reader.length) {
    throw new DnsError("record overruns message", "TRUNCATED");
  }
  const data = parseRdata(reader, type, rdlength);
  // Defensive: a parser that under-read must not desync the next record.
  if (reader.offset !== recordStart + rdlength) {
    throw new DnsError(
      `record parser consumed ${reader.offset - recordStart} of ${rdlength} rdata bytes`,
      "BAD_RDATA",
    );
  }
  return {
    name,
    type,
    typeName: TYPE_NAMES[type] ?? `TYPE${type}`,
    ttl,
    data,
    raw: reader.slice(recordStart, recordStart + rdlength),
  };
}

/** Decode a full DNS message (query or response) from raw bytes. */
export function decodeMessage(buf: Buffer): DnsMessage {
  if (buf.length < 12) throw new DnsError("truncated DNS message (shorter than header)", "TRUNCATED");
  const reader = new Reader(buf);
  const id = reader.uint16();
  const flags = reader.uint16();
  const qdcount = reader.uint16();
  const ancount = reader.uint16();
  const nscount = reader.uint16();
  const arcount = reader.uint16();

  const questions: DnsMessage["questions"] = [];
  for (let i = 0; i < qdcount; i++) {
    const name = reader.name();
    const type = reader.uint16();
    reader.uint16(); // qclass
    questions.push({ name, type, typeName: TYPE_NAMES[type] ?? `TYPE${type}` });
  }

  const readSection = (count: number): DnsRecord[] => {
    const out: DnsRecord[] = [];
    for (let i = 0; i < count; i++) out.push(readRecord(reader));
    return out;
  };

  return {
    id,
    isResponse: (flags & 0x8000) !== 0,
    opcode: (flags >> 11) & 0xf,
    authoritative: (flags & 0x0400) !== 0,
    truncated: (flags & 0x0200) !== 0,
    recursionDesired: (flags & 0x0100) !== 0,
    recursionAvailable: (flags & 0x0080) !== 0,
    rcode: flags & 0x000f,
    questions,
    answers: readSection(ancount),
    authority: readSection(nscount),
    additional: readSection(arcount),
  };
}

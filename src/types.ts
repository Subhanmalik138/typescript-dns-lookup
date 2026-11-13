/**
 * Shared DNS types and constants.
 *
 * Record type numbers follow RFC 1035 (A, NS, CNAME, SOA, PTR, MX, TXT)
 * and RFC 3596 (AAAA).
 */

export type RecordTypeName =
  | "A"
  | "AAAA"
  | "NS"
  | "CNAME"
  | "SOA"
  | "PTR"
  | "MX"
  | "TXT";

export const RECORD_TYPES: Record<RecordTypeName, number> = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
} as const;

export const TYPE_NAMES: Record<number, RecordTypeName | string> = {
  1: "A",
  2: "NS",
  5: "CNAME",
  6: "SOA",
  12: "PTR",
  15: "MX",
  16: "TXT",
  28: "AAAA",
  33: "SRV",
  41: "OPT",
};

export const CLASS_IN = 1;

/** A single decoded resource record. */
export interface DnsRecord {
  name: string;
  type: number;
  typeName: string;
  ttl: number;
  /** Human-readable rdata: IP, domain name, "10 mail.example.com.", ... */
  data: string;
  /** Raw rdata bytes, for callers that need the unparsed form. */
  raw: Buffer;
}

/** A decoded DNS message. */
export interface DnsMessage {
  id: number;
  /** QR bit: true when this is a response. */
  isResponse: boolean;
  opcode: number;
  authoritative: boolean;
  truncated: boolean;
  recursionDesired: boolean;
  recursionAvailable: boolean;
  /** Response code: 0 = NOERROR, 3 = NXDOMAIN, ... */
  rcode: number;
  questions: { name: string; type: number; typeName: string }[];
  answers: DnsRecord[];
  authority: DnsRecord[];
  additional: DnsRecord[];
}

export const RCODE_NAMES: Record<number, string> = {
  0: "NOERROR",
  1: "FORMERR",
  2: "SERVFAIL",
  3: "NXDOMAIN",
  4: "NOTIMP",
  5: "REFUSED",
};

export class DnsError extends Error {
  readonly code: string;
  constructor(message: string, code = "DNS_ERROR") {
    super(message);
    this.name = "DnsError";
    this.code = code;
  }
}

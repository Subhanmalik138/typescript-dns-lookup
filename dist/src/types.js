/**
 * Shared DNS types and constants.
 *
 * Record type numbers follow RFC 1035 (A, NS, CNAME, SOA, PTR, MX, TXT)
 * and RFC 3596 (AAAA).
 */
export const RECORD_TYPES = {
    A: 1,
    NS: 2,
    CNAME: 5,
    SOA: 6,
    PTR: 12,
    MX: 15,
    TXT: 16,
    AAAA: 28,
};
export const TYPE_NAMES = {
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
export const RCODE_NAMES = {
    0: "NOERROR",
    1: "FORMERR",
    2: "SERVFAIL",
    3: "NXDOMAIN",
    4: "NOTIMP",
    5: "REFUSED",
};
export class DnsError extends Error {
    code;
    constructor(message, code = "DNS_ERROR") {
        super(message);
        this.name = "DnsError";
        this.code = code;
    }
}

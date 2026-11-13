/** Public API: everything a library consumer needs. */
export { DnsCache } from "./cache.js";
export { DnsClient, createUdpTransport, systemServers } from "./client.js";
export { DnsError, RECORD_TYPES, RCODE_NAMES, TYPE_NAMES, CLASS_IN, } from "./types.js";
export { decodeMessage, encodeName, encodeQuery, formatIPv6, splitLabels } from "./wire.js";

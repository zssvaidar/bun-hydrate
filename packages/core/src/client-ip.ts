import { isIP } from "node:net";

/**
 * Which proxies may tell us the client's address (spec-5 §1.1):
 * `false` trusts none, a number trusts that many hops, a list trusts those addresses/CIDRs.
 */
export type TrustProxy = false | number | readonly string[];

export interface ClientInfo {
  ip: string;
  protocol: "http" | "https";
}

interface ParsedAddress {
  version: 4 | 6;
  value: bigint;
}

const IPV4_MAPPED = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

function parseAddress(raw: string): ParsedAddress | undefined {
  const address = raw.trim().replace(IPV4_MAPPED, "$1");
  const version = isIP(address);
  if (version === 4) {
    return { version: 4, value: address.split(".").reduce((acc, octet) => (acc << 8n) + BigInt(Number(octet)), 0n) };
  }
  if (version === 6) return { version: 6, value: ipv6ToBigInt(address) };
  return undefined;
}

function ipv6ToBigInt(address: string): bigint {
  const [head = "", tail = ""] = address.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const groups = address.includes("::")
    ? [...headGroups, ...Array(8 - headGroups.length - tailGroups.length).fill("0"), ...tailGroups]
    : headGroups;
  return groups.reduce((acc, group) => (acc << 16n) + BigInt(parseInt(group || "0", 16)), 0n);
}

/** Returns a predicate that tells whether an address falls in any of the given addresses/CIDRs. */
export function ipMatcher(entries: readonly string[]): (address: string) => boolean {
  const ranges = entries.map((entry) => {
    const [base = "", prefixText] = entry.split("/");
    const parsed = parseAddress(base);
    const width = parsed?.version === 4 ? 32 : 128;
    const prefix = prefixText === undefined ? width : Number(prefixText);
    if (!parsed || !Number.isInteger(prefix) || prefix < 0 || prefix > width) {
      throw new Error(`Invalid trusted proxy "${entry}": expected an IP address or CIDR like 10.0.0.0/8`);
    }
    const hostBits = BigInt(width - prefix);
    return { version: parsed.version, network: parsed.value >> hostBits, hostBits };
  });

  return (address) => {
    const parsed = parseAddress(address);
    if (!parsed) return false;
    return ranges.some(
      (range) => range.version === parsed.version && parsed.value >> range.hostBits === range.network,
    );
  };
}

function isTrustedHop(trust: TrustProxy, matcher: ((address: string) => boolean) | undefined) {
  return (address: string, hopsFromServer: number) =>
    typeof trust === "number" ? hopsFromServer < trust : (matcher?.(address) ?? false);
}

/**
 * Works out the client address and protocol. The chain is X-Forwarded-For plus the socket
 * peer; it is walked from the server outwards, and only trusted hops may vouch for the next.
 */
export function resolveClient(
  request: Request,
  socketAddress: string | undefined,
  trust: TrustProxy,
  matcher = Array.isArray(trust) ? ipMatcher(trust) : undefined,
): ClientInfo {
  const peer = socketAddress ?? "127.0.0.1";
  const ownProtocol = new URL(request.url).protocol === "https:" ? "https" : "http";
  const trusted = isTrustedHop(trust, matcher);

  if (trust === false || !trusted(peer, 0)) return { ip: peer, protocol: ownProtocol };

  const forwarded = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const chain = [...forwarded, peer];

  let index = chain.length - 1;
  while (index > 0 && trusted(chain[index]!, chain.length - 1 - index)) {
    if (!parseAddress(chain[index - 1]!)) break; // malformed entry: keep the proxy that reported it
    index--;
  }

  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const protocol = proto === "https" || proto === "http" ? proto : ownProtocol;
  return { ip: chain[index]!.replace(IPV4_MAPPED, "$1"), protocol };
}

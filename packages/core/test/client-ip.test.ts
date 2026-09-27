import { describe, expect, test } from "bun:test";
import { ipMatcher, resolveClient } from "../src/client-ip";

function request(headers: Record<string, string> = {}, url = "http://app.test/") {
  return new Request(url, { headers });
}

describe("ipMatcher", () => {
  test("matches IPv4 CIDRs and single addresses", () => {
    const trusted = ipMatcher(["10.0.0.0/8", "192.168.1.7"]);

    expect(trusted("10.20.30.40")).toBe(true);
    expect(trusted("11.0.0.1")).toBe(false);
    expect(trusted("192.168.1.7")).toBe(true);
    expect(trusted("192.168.1.8")).toBe(false);
  });

  test("matches IPv6 CIDRs and treats IPv4-mapped IPv6 as IPv4", () => {
    const trusted = ipMatcher(["fd00::/8", "127.0.0.1"]);

    expect(trusted("fd12:3456::1")).toBe(true);
    expect(trusted("fe80::1")).toBe(false);
    expect(trusted("::ffff:127.0.0.1")).toBe(true);
    expect(trusted("::1")).toBe(false);
  });

  test("rejects invalid entries at construction", () => {
    expect(() => ipMatcher(["10.0.0.0/33"])).toThrow('Invalid trusted proxy "10.0.0.0/33"');
    expect(() => ipMatcher(["not-an-ip"])).toThrow('Invalid trusted proxy "not-an-ip"');
  });

  test("never matches garbage addresses", () => {
    expect(ipMatcher(["0.0.0.0/0"])("junk")).toBe(false);
  });
});

describe("resolveClient", () => {
  const spoofed = { "x-forwarded-for": "6.6.6.6", "x-forwarded-proto": "https" };

  test("ignores forwarding headers unless proxies are trusted", () => {
    expect(resolveClient(request(spoofed), "203.0.113.5", false)).toEqual({ ip: "203.0.113.5", protocol: "http" });
  });

  test("hop count: trusts exactly that many proxies from the right", () => {
    const headers = { "x-forwarded-for": "6.6.6.6, 198.51.100.1, 10.0.0.2", "x-forwarded-proto": "https" };

    expect(resolveClient(request(headers), "10.0.0.1", 1)).toEqual({ ip: "10.0.0.2", protocol: "https" });
    expect(resolveClient(request(headers), "10.0.0.1", 2)).toEqual({ ip: "198.51.100.1", protocol: "https" });
    expect(resolveClient(request(headers), "10.0.0.1", 10)).toEqual({ ip: "6.6.6.6", protocol: "https" });
  });

  test("CIDR list: the client is the first untrusted address from the right", () => {
    const headers = { "x-forwarded-for": "6.6.6.6, 198.51.100.1, 10.0.0.2" };

    expect(resolveClient(request(headers), "10.0.0.1", ["10.0.0.0/8"])).toEqual({ ip: "198.51.100.1", protocol: "http" });
  });

  test("CIDR list: an untrusted peer means its forwarding headers are ignored", () => {
    expect(resolveClient(request(spoofed), "203.0.113.5", ["10.0.0.0/8"])).toEqual({
      ip: "203.0.113.5",
      protocol: "http",
    });
  });

  test("the protocol comes from the request URL without trusted forwarding", () => {
    expect(resolveClient(request({}, "https://app.test/"), "203.0.113.5", false).protocol).toBe("https");
  });

  test("stops at a malformed forwarded entry and uses the proxy that reported it", () => {
    const headers = { "x-forwarded-for": "6.6.6.6, <script>, 10.0.0.2" };
    expect(resolveClient(request(headers), "10.0.0.1", ["10.0.0.0/8"]).ip).toBe("10.0.0.2");
  });

  test("without a socket (in-process tests) the address is 127.0.0.1", () => {
    expect(resolveClient(request(), undefined, false).ip).toBe("127.0.0.1");
  });
});

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { badRequest } from "./errors";

/** True for loopback, private, link-local, CGNAT, unique-local and unspecified addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || /^fe[89ab]/.test(v);
  }
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * Rejects hosts that resolve to private networks unless the operator allowed
 * it (GETMAN_ALLOW_PRIVATE_NETWORKS). Applies to backup targets and AI base URLs.
 */
export async function assertReachableHost(host: string, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) return;
  const name = host.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(name) ? [name] : (await lookup(name, { all: true })).map((a) => a.address);
  } catch {
    throw badRequest(`Cannot resolve host "${name}"`, "host_unresolvable");
  }
  if (addresses.some(isPrivateAddress)) {
    throw badRequest(
      `"${name}" is on a private network. The server administrator must set GETMAN_ALLOW_PRIVATE_NETWORKS=true to allow it.`,
      "private_network",
    );
  }
}

export async function assertReachableUrl(url: string, allowPrivate: boolean): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest(`Invalid URL: ${url}`);
  }
  if (!["http:", "https:", "postgres:", "postgresql:"].includes(parsed.protocol)) throw badRequest(`Unsupported URL scheme: ${parsed.protocol}`);
  await assertReachableHost(parsed.hostname, allowPrivate);
  return parsed;
}

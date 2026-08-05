import dns from "node:dns/promises";
import net from "node:net";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export class TargetAccessError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "TargetAccessError";
    this.code = "TARGET_ACCESS";
    this.retryable = Boolean(options.retryable);
  }
}

export function normalizeReviewTarget(input) {
  const value = String(input ?? "").trim();
  if (!value) throw new TargetAccessError("repository_or_url is empty");

  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    const [owner, repo] = value.split("/");
    return {
      kind: "github_repo",
      owner,
      repo,
      url: `https://github.com/${owner}/${repo}`,
    };
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TargetAccessError("repository_or_url must be a GitHub slug or HTTPS URL");
  }

  validateUrlShape(url);
  const githubParts = githubRepositoryParts(url);
  if (githubParts) {
    return {
      kind: "github_repo",
      owner: githubParts.owner,
      repo: githubParts.repo,
      url: `https://github.com/${githubParts.owner}/${githubParts.repo}`,
    };
  }

  return { kind: "https_url", url: url.toString() };
}

export async function assertPublicUrl(value) {
  const url = assertUrlNotObviouslyPrivate(value);

  const hostname = url.hostname.toLowerCase();
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new TargetAccessError("private, loopback, or link-local targets are not allowed");
    }
    return url;
  }

  if (isBlockedHostname(hostname)) {
    throw new TargetAccessError("local or metadata hostnames are not allowed");
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new TargetAccessError(`target DNS lookup failed: ${error.message}`);
  }

  if (!addresses.length || addresses.some(address => isPrivateAddress(address.address))) {
    throw new TargetAccessError("target resolves to a private, loopback, or link-local address");
  }

  return url;
}

export function assertUrlNotObviouslyPrivate(value) {
  const url = value instanceof URL ? value : new URL(String(value));
  validateUrlShape(url);
  const hostname = url.hostname.toLowerCase();
  if ((net.isIP(hostname) && isPrivateAddress(hostname)) || isBlockedHostname(hostname)) {
    throw new TargetAccessError("private, loopback, or metadata targets are not allowed");
  }
  return url;
}

export async function safeFetch(input, init = {}, options = {}) {
  let current = input instanceof URL ? input.toString() : String(input);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    await assertPublicUrl(current);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(current, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status < 300 || response.status >= 400) return response;

      const location = response.headers.get("location");
      if (!location || redirect === maxRedirects) {
        throw new TargetAccessError("target redirect chain is invalid or too long");
      }
      current = new URL(location, current).toString();
    } catch (error) {
      if (error instanceof TargetAccessError) throw error;
      if (error.name === "AbortError") {
        throw new TargetAccessError("target request timed out", { retryable: true });
      }
      throw new TargetAccessError(`target request failed: ${error.message}`, {
        retryable: true,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new TargetAccessError("target redirect chain exceeded the limit");
}

export async function readResponseText(response, maxBytes = 64 * 1024) {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > maxBytes) {
    throw new TargetAccessError("target response exceeds the size limit");
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new TargetAccessError("target response exceeds the size limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  return new TextDecoder().decode(concatChunks(chunks, total));
}

export function sanitizeEvidenceText(value, maxLength = 4000) {
  return String(value ?? "")
    .replace(/(authorization|cookie|api[-_ ]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1: [REDACTED]")
    .slice(0, maxLength);
}

function validateUrlShape(url) {
  if (!/^https?:$/.test(url.protocol)) {
    throw new TargetAccessError("only HTTP and HTTPS targets are allowed");
  }
  if (url.username || url.password) {
    throw new TargetAccessError("target URLs must not contain credentials");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new TargetAccessError("only ports 80 and 443 are allowed");
  }
}

function githubRepositoryParts(url) {
  if (url.hostname.toLowerCase() !== "github.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0].startsWith(".")) return null;
  const repo = parts[1].replace(/\.git$/, "");
  if (!/^[A-Za-z0-9_.-]+$/.test(parts[0]) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    return null;
  }
  return { owner: parts[0], repo };
}

function isBlockedHostname(hostname) {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal" ||
    hostname === "metadata.google" ||
    hostname === "instance-data.ec2.internal"
  );
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const octets = address.split(".").map(Number);
    const first = octets[0];
    const second = octets[1];
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 192 && second === 0) ||
      (first === 198 && second >= 18 && second <= 19) ||
      first >= 224
    );
  }

  const normalized = address.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.") ||
    normalized.startsWith("::ffff:127.")
  );
}

function concatChunks(chunks, total) {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

import dns from "node:dns/promises";
import net from "node:net";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export class TargetAccessError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "TargetAccessError";
    this.code = options.code ?? "TARGET_ACCESS";
    this.retryable = Boolean(options.retryable);
    this.statusCode = options.statusCode ?? 400;
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

  if (url.protocol !== "https:") {
    throw new TargetAccessError("endpoint targets must use HTTPS");
  }
  return { kind: "https_url", url: url.toString() };
}

export async function assertPublicUrl(value, options = {}) {
  const url = assertUrlNotObviouslyPrivate(value);

  const hostname = normalizedHostname(url);
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
    const lookup = options.lookup ?? dns.lookup.bind(dns);
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new TargetAccessError(`target DNS lookup failed: ${error.message}`, {
      code: "TARGET_DNS_FAILED",
      retryable: true,
      statusCode: 502,
    });
  }

  if (!addresses.length || addresses.some(address => isPrivateAddress(address.address))) {
    throw new TargetAccessError("target resolves to a private, loopback, or link-local address");
  }

  return url;
}

export function assertUrlNotObviouslyPrivate(value) {
  const url = value instanceof URL ? value : new URL(String(value));
  validateUrlShape(url);
  const hostname = normalizedHostname(url);
  if ((net.isIP(hostname) && isPrivateAddress(hostname)) || isBlockedHostname(hostname)) {
    throw new TargetAccessError("private, loopback, or metadata targets are not allowed");
  }
  return url;
}

export async function safeFetch(input, init = {}, options = {}) {
  const { response } = await safeFetchWithTrace(input, init, options);
  return response;
}

export async function safeFetchWithTrace(input, init = {}, options = {}) {
  let current = input instanceof URL ? new URL(input) : new URL(String(input));
  let currentInit = cloneRequestInit(init);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const startedAt = Date.now();
  const redirects = [];

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    if (options.httpsOnly && current.protocol !== "https:") {
      throw new TargetAccessError("target and redirect URLs must use HTTPS", {
        code: "TARGET_PROTOCOL_BLOCKED",
      });
    }
    await assertPublicUrl(current, options);
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      throw new TargetAccessError("target request timed out", {
        code: "TARGET_TIMEOUT",
        retryable: true,
        statusCode: 504,
      });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remainingMs);
    try {
      const response = await fetchImpl(current.toString(), {
        ...currentInit,
        redirect: "manual",
        signal: controller.signal,
      });
      if (!isRedirectStatus(response.status)) {
        return {
          response,
          finalUrl: current.toString(),
          redirects,
          deadlineAt: startedAt + timeoutMs,
        };
      }

      await response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      if (!location || redirect === maxRedirects) {
        throw new TargetAccessError("target redirect chain is invalid or too long", {
          code: "TARGET_REDIRECT_BLOCKED",
        });
      }
      const next = new URL(location, current);
      if (next.origin !== current.origin) {
        currentInit = {
          ...currentInit,
          headers: withoutSensitiveRedirectHeaders(currentInit.headers),
        };
      }
      if (redirectChangesToGet(response.status, currentInit.method)) {
        currentInit = {
          ...currentInit,
          method: "GET",
          body: undefined,
          headers: withoutEntityHeaders(currentInit.headers),
        };
      }
      redirects.push({
        from: current.toString(),
        to: next.toString(),
        statusCode: response.status,
      });
      current = next;
    } catch (error) {
      if (error instanceof TargetAccessError) throw error;
      if (error.name === "AbortError") {
        throw new TargetAccessError("target request timed out", {
          code: "TARGET_TIMEOUT",
          retryable: true,
          statusCode: 504,
        });
      }
      throw new TargetAccessError(`target request failed: ${error.message}`, {
        code: "TARGET_UNREACHABLE",
        retryable: true,
        statusCode: 502,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new TargetAccessError("target redirect chain exceeded the limit", {
    code: "TARGET_REDIRECT_BLOCKED",
  });
}

export async function readResponseText(response, maxBytes = 64 * 1024, options = {}) {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > maxBytes) {
    throw new TargetAccessError("target response exceeds the size limit", {
      code: "TARGET_RESPONSE_TOO_LARGE",
      statusCode: 502,
    });
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const next = await readChunk(reader, options.deadlineAt);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new TargetAccessError("target response exceeds the size limit", {
          code: "TARGET_RESPONSE_TOO_LARGE",
          statusCode: 502,
        });
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof TargetAccessError && error.code === "TARGET_TIMEOUT") {
      await reader.cancel().catch(() => {});
    }
    throw error;
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
      (first === 192 && second === 0 && octets[2] === 2) ||
      (first === 198 && second >= 18 && second <= 19) ||
      (first === 198 && second === 51 && octets[2] === 100) ||
      (first === 203 && second === 0 && octets[2] === 113) ||
      first >= 224
    );
  }

  const normalized = address.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("ff") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("2001:db8:") ||
    normalized.startsWith("::ffff:")
  );
}

function normalizedHostname(url) {
  const hostname = url.hostname.toLowerCase();
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

function redirectChangesToGet(status, method) {
  const normalized = String(method ?? "GET").toUpperCase();
  return status === 303
    ? normalized !== "HEAD"
    : [301, 302].includes(status) && normalized === "POST";
}

function cloneRequestInit(init) {
  return {
    ...init,
    headers: new Headers(init.headers ?? {}),
  };
}

function withoutSensitiveRedirectHeaders(headers) {
  const copy = new Headers(headers);
  for (const name of [
    "authorization",
    "cookie",
    "proxy-authorization",
    "x-api-key",
    "payment",
    "payment-signature",
    "x-payment",
    "x-402-payment",
    "x402-payment",
    "x-x402-signature",
    "x-x402-timestamp",
  ]) {
    copy.delete(name);
  }
  return copy;
}

function withoutEntityHeaders(headers) {
  const copy = new Headers(headers);
  for (const name of ["content-encoding", "content-language", "content-length", "content-type"]) {
    copy.delete(name);
  }
  return copy;
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

async function readChunk(reader, deadlineAt) {
  if (!Number.isFinite(deadlineAt)) return reader.read();
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw targetTimeoutError();
  let timeout;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(targetTimeoutError()), remainingMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function targetTimeoutError() {
  return new TargetAccessError("target request timed out", {
    code: "TARGET_TIMEOUT",
    retryable: true,
    statusCode: 504,
  });
}

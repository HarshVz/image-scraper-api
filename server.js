
import http from "node:http";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const PORT = Number(process.env.PORT) || 7860;
const MAX_LIMIT = 50;
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 12000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Add your proxy URLs here, or configure PROXIES_JSON in Koyeb.
// Example: ["http://username:password@host:port"]
const PROXIES = [
  // "http://USER:PASS@IP:PORT",
];

function parseProxies() {
  let entries = PROXIES;

  if (process.env.PROXIES_JSON) {
    try {
      const parsed = JSON.parse(process.env.PROXIES_JSON);

      if (!Array.isArray(parsed)) {
        throw new Error("PROXIES_JSON must be a JSON array");
      }

      entries = parsed;
    } catch (error) {
      throw new Error(`Invalid PROXIES_JSON: ${error.message}`);
    }
  }

  return entries.filter((value) => {
    if (typeof value !== "string") return false;

    try {
      const url = new URL(value);

      return (
        url.protocol === "http:" &&
        Boolean(url.hostname) &&
        Boolean(url.port) &&
        !value.includes("USER:PASS") &&
        !value.includes("IP_")
      );
    } catch {
      return false;
    }
  });
}

const VALID_PROXIES = parseProxies();

function getRandomProxy(excluded = new Set()) {
  const available = VALID_PROXIES.filter(
    (proxy) => !excluded.has(proxy)
  );

  if (available.length === 0) return undefined;

  return available[Math.floor(Math.random() * available.length)];
}

function extractVqd(html) {
  const match =
    html.match(/\bvqd\s*=\s*['"]([^'"]+)['"]/) ||
    html.match(/\bvqd=([\d-]{5,})/);

  return match?.[1] ?? null;
}

class UpstreamError extends Error {
  constructor(message, retryable = false) {
    super(message);
    this.name = "UpstreamError";
    this.retryable = retryable;
  }
}

async function fetchWithTimeout(url, options) {
  return undiciFetch(url, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function searchOnce(query, limit, proxyUrl) {
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

  try {
    const searchUrl = new URL("https://duckduckgo.com/");
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("t", "h_");
    searchUrl.searchParams.set("iax", "images");
    searchUrl.searchParams.set("ia", "images");

    const tokenResponse = await fetchWithTimeout(searchUrl, {
      dispatcher,
      headers: { "User-Agent": USER_AGENT },
    });

    if (!tokenResponse.ok) {
      const status = tokenResponse.status;

      await tokenResponse.body?.cancel().catch(() => {});

      throw new UpstreamError(
        `Token request failed: HTTP ${status}`,
        status >= 500
      );
    }

    const html = await tokenResponse.text();
    const vqd = extractVqd(html);

    if (!vqd) {
      throw new UpstreamError(
        "Could not extract the DuckDuckGo VQD token"
      );
    }

    const imageUrl = new URL("https://duckduckgo.com/i.js");
    imageUrl.searchParams.set("l", "wt-wt");
    imageUrl.searchParams.set("o", "json");
    imageUrl.searchParams.set("q", query);
    imageUrl.searchParams.set("vqd", vqd);
    imageUrl.searchParams.set("f", ",,,,,");
    imageUrl.searchParams.set("p", "1");

    const imageResponse = await fetchWithTimeout(imageUrl, {
      dispatcher,
      headers: {
        "User-Agent": USER_AGENT,
        Referer: "https://duckduckgo.com/",
        Accept: "application/json",
      },
    });

    if (!imageResponse.ok || imageResponse.status === 202) {
      const status = imageResponse.status;

      await imageResponse.body?.cancel().catch(() => {});

      throw new UpstreamError(
        `Image request failed: HTTP ${status}`,
        status >= 500
      );
    }

    let data;

    try {
      data = await imageResponse.json();
    } catch {
      throw new UpstreamError("Invalid JSON from DuckDuckGo");
    }

    if (!Array.isArray(data.results)) {
      throw new UpstreamError(
        "Unexpected response format from DuckDuckGo"
      );
    }

    return data.results.slice(0, limit).map((item) => ({
      title: item.title ?? "",
      image: item.image ?? null,
      thumbnail: item.thumbnail ?? null,
      width: item.width ?? null,
      height: item.height ?? null,
      sourceUrl: item.url ?? null,
      source: item.source ?? null,
    }));
  } finally {
    await dispatcher?.close().catch(() => {});
  }
}

function isRetryable(error) {
  if (error instanceof UpstreamError) {
    return error.retryable;
  }

  // Retry transient network errors and request timeouts.
  return (
    error?.name === "TimeoutError" ||
    error?.name === "AbortError" ||
    error?.name === "TypeError"
  );
}

async function searchDuckDuckGoImages(query, limit) {
  const excludedProxies = new Set();
  const attempts = Math.min(
    MAX_RETRIES,
    Math.max(1, VALID_PROXIES.length || 1)
  );

  let lastError;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const proxyUrl = getRandomProxy(excludedProxies);

    if (proxyUrl) excludedProxies.add(proxyUrl);

    try {
      return await searchOnce(query, limit, proxyUrl);
    } catch (error) {
      lastError = error;

      if (!isRetryable(error) || attempt === attempts - 1) {
        break;
      }
    }
  }

  throw lastError ?? new Error("Image search failed");
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.method !== "GET") {
    res.writeHead(405);
    return res.end(
      JSON.stringify({ error: "Method not allowed" })
    );
  }

  let url;

  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: "Invalid URL" }));
  }

  const query = url.searchParams.get("q")?.trim();

  if (!query) {
    res.writeHead(400);
    return res.end(
      JSON.stringify({ error: "Missing ?q= parameter" })
    );
  }

  if (query.length > 300) {
    res.writeHead(400);
    return res.end(
      JSON.stringify({ error: "Query must be 300 characters or fewer" })
    );
  }

  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? 15 : Number(rawLimit);

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    res.writeHead(400);
    return res.end(
      JSON.stringify({
        error: `limit must be an integer between 1 and ${MAX_LIMIT}`,
      })
    );
  }

  try {
    const results = await searchDuckDuckGoImages(query, limit);

    res.writeHead(200);
    res.end(
      JSON.stringify({
        query,
        count: results.length,
        results,
      })
    );
  } catch (error) {
    console.error("Image search failed:", error.message);

    res.writeHead(502);
    res.end(
      JSON.stringify({ error: "Image search provider request failed" })
    );
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Image Search API listening on port ${PORT}`);
});

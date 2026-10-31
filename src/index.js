import { json } from "./http.js";
import {
  clampLimit,
  getHistory,
  getTicker,
  getTickers,
  parseInterval,
  parseSymbol,
} from "./market.js";
import { getSymbolList, searchSymbols } from "./symbols.js";
import { handleWatchlist } from "./watchlist.js";

function intParam(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseSymbolList(value) {
  const seen = new Set();
  const list = [];

  for (const part of String(value || "").split(",")) {
    const symbol = parseSymbol(part);
    if (symbol && !seen.has(symbol)) {
      seen.add(symbol);
      list.push(symbol);
    }
    if (list.length >= 50) break;
  }

  return list;
}

async function routeApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/health" && method === "GET") {
    return json({
      ok: true,
      d1: Boolean(env.DB),
      now: new Date().toISOString(),
      version: "1.0.0",
    });
  }

  if (path === "/api/symbols" && method === "GET") {
    const query = url.searchParams.get("q") || "";
    const limit = Math.min(200, Math.max(1, intParam(url.searchParams.get("limit"), 60)));
    const { symbols, source } = await getSymbolList();

    return json({
      symbols: searchSymbols(symbols, query, limit),
      total: symbols.length,
      source,
    });
  }

  if (path === "/api/history" && method === "GET") {
    const symbol = parseSymbol(url.searchParams.get("symbol"));
    if (!symbol) return json({ error: "invalid_symbol" }, 400);

    const interval = parseInterval(url.searchParams.get("interval"));
    if (!interval) return json({ error: "invalid_interval" }, 400);

    const limit = clampLimit(intParam(url.searchParams.get("limit"), 600));
    return json(await getHistory(symbol, interval, limit));
  }

  if (path === "/api/ticker" && method === "GET") {
    const symbol = parseSymbol(url.searchParams.get("symbol"));
    if (!symbol) return json({ error: "invalid_symbol" }, 400);
    return json(await getTicker(symbol));
  }

  if (path === "/api/tickers" && method === "GET") {
    const symbols = parseSymbolList(url.searchParams.get("symbols"));
    if (!symbols.length) return json({ error: "invalid_symbols" }, 400);
    return json(await getTickers(symbols));
  }

  const watchlist = await handleWatchlist(request, env, url);
  if (watchlist) return watchlist;

  return json({ error: "not_found" }, 404);
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return withSecurityHeaders(await routeApi(request, env, url));
      } catch (error) {
        console.error("api_error", url.pathname, error);
        return json({ error: "internal_error" }, 500);
      }
    }

    const response = await env.ASSETS.fetch(request);

    if (response.status === 404 && request.method === "GET") {
      return withSecurityHeaders(
        await env.ASSETS.fetch(
          new Request(new URL("/", url).toString(), { headers: request.headers }),
        ),
      );
    }

    return withSecurityHeaders(response);
  },
};

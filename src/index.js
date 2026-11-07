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
import { handleTelegram } from "./telegram.js";
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

const DIAG_TARGETS = [
  { name: "binance", url: "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1" },
  { name: "binance-vision", url: "https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1" },
  { name: "binance-api1", url: "https://api1.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1" },
  { name: "binance-api2", url: "https://api2.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1" },
  { name: "binance-us", url: "https://api.binance.us/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1" },
  { name: "mexc", url: "https://api.mexc.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1" },
  { name: "bybit", url: "https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=1&limit=1" },
  { name: "okx", url: "https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1m&limit=1" },
  { name: "kucoin", url: "https://api.kucoin.com/api/v1/market/candles?type=1min&symbol=BTC-USDT" },
  { name: "bitget", url: "https://api.bitget.com/api/v2/spot/market/candles?symbol=BTCUSDT&granularity=1min&limit=1" },
  { name: "gate", url: "https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=BTC_USDT&interval=1m&limit=1" },
  { name: "coinbase", url: "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60" },
  { name: "kraken", url: "https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1" },
  { name: "bitstamp", url: "https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=60&limit=1" },
];

// Reports which market-data providers this edge location can actually reach.
async function diagnose(request) {
  const started = Date.now();

  const results = await Promise.all(
    DIAG_TARGETS.map(async (target) => {
      const began = Date.now();

      try {
        const response = await fetch(target.url, {
          headers: { accept: "application/json", "user-agent": "OpenTrading/1.0" },
          signal: AbortSignal.timeout(6000),
        });
        const text = await response.text();

        return {
          name: target.name,
          ok: response.ok,
          status: response.status,
          ms: Date.now() - began,
          sample: text.slice(0, 90),
        };
      } catch (error) {
        return {
          name: target.name,
          ok: false,
          status: 0,
          ms: Date.now() - began,
          error: String((error && error.message) || error),
        };
      }
    }),
  );

  return json({
    colo: (request.cf && request.cf.colo) || null,
    tookMs: Date.now() - started,
    results,
  });
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

  if (path === "/api/diag" && method === "GET") {
    return diagnose(request);
  }

  const watchlist = await handleWatchlist(request, env, url);
  if (watchlist) return watchlist;

  const telegram = await handleTelegram(request, env, url);
  if (telegram) return telegram;

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

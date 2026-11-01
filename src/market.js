const CACHE_ORIGIN = "https://cache.opentrading.internal/v2";

/*
 * Binance rejects requests from some Cloudflare edge locations.
 * data-api.binance.vision is the official public market-data front door and is
 * reachable from more places, so every REST call walks this list until one host
 * answers. Dead hosts are skipped for HOST_COOLDOWN_MS to keep latency low.
 */
const BINANCE_HOSTS = [
  "https://api.binance.com",
  "https://data-api.binance.vision",
  "https://api1.binance.com",
  "https://api2.binance.com",
];

const HOST_COOLDOWN_MS = 10 * 60 * 1000;
const hostState = BINANCE_HOSTS.map(() => ({ downUntil: 0 }));
let preferredHost = 0;

function hostOrder() {
  const now = Date.now();
  const alive = [];
  const cooling = [];

  for (let i = 0; i < BINANCE_HOSTS.length; i++) {
    const index = (preferredHost + i) % BINANCE_HOSTS.length;
    if (hostState[index].downUntil > now) cooling.push(index);
    else alive.push(index);
  }

  return alive.concat(cooling);
}

export const INTERVALS = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
};

const BASE_PRICES = {
  BTCUSDT: 68000,
  ETHUSDT: 3400,
  SOLUSDT: 165,
  BNBUSDT: 590,
  XRPUSDT: 0.62,
  DOGEUSDT: 0.14,
  ADAUSDT: 0.45,
  AVAXUSDT: 28,
  LINKUSDT: 15.5,
  TONUSDT: 5.6,
  DOTUSDT: 6.2,
  SUIUSDT: 3.4,
  LTCUSDT: 82,
  BCHUSDT: 420,
  TRXUSDT: 0.13,
  NEARUSDT: 5.1,
  APTUSDT: 8.4,
  ARBUSDT: 0.85,
  OPUSDT: 1.9,
  PEPEUSDT: 0.000011,
  SHIBUSDT: 0.000018,
  UNIUSDT: 9.2,
  ATOMUSDT: 7.4,
  FILUSDT: 5.3,
  INJUSDT: 22,
  SEIUSDT: 0.42,
  TIAUSDT: 6.8,
  FETUSDT: 1.35,
  WIFUSDT: 2.1,
  RNDRUSDT: 7.6,
};

export function parseSymbol(value) {
  if (typeof value !== "string") return null;
  const symbol = value.trim().toUpperCase();
  return /^[A-Z0-9]{4,20}$/.test(symbol) ? symbol : null;
}

export function parseInterval(value) {
  return typeof value === "string" && Object.hasOwn(INTERVALS, value) ? value : null;
}

export function clampLimit(limit) {
  if (!Number.isFinite(limit)) return 600;
  return Math.min(1000, Math.max(20, Math.trunc(limit)));
}

async function cachedJson(key, ttlSeconds, producer) {
  const request = new Request(key);
  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;

  if (cache) {
    try {
      const hit = await cache.match(request);
      if (hit) return await hit.json();
    } catch {
      // Cache API is best effort: fall through to the producer.
    }
  }

  const data = await producer();

  if (cache) {
    try {
      const stored = new Response(JSON.stringify(data), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": `public, max-age=${ttlSeconds}`,
        },
      });
      await cache.put(request, stored);
    } catch {
      // Ignore cache write failures.
    }
  }

  return data;
}

export { cachedJson };

export async function binanceFetch(path, options = {}) {
  const timeout = options.timeout || 4500;
  let lastError = null;

  for (const index of hostOrder()) {
    const host = BINANCE_HOSTS[index];

    try {
      const response = await fetch(`${host}${path}`, {
        headers: {
          accept: "application/json",
          "user-agent": "OpenTrading/1.0",
        },
        signal: AbortSignal.timeout(timeout),
      });

      if (!response.ok) {
        const error = new Error(`binance_http_${response.status}`);
        error.status = response.status;
        throw error;
      }

      const data = await response.json();
      preferredHost = index;
      hostState[index].downUntil = 0;
      return data;
    } catch (error) {
      // A 4xx that is not a regional block or rate limit means the host is up
      // and the request itself was wrong: fail fast instead of failing over.
      const status = error && error.status;
      if (status && status < 500 && status !== 403 && status !== 418 && status !== 429 && status !== 451) {
        throw error;
      }

      lastError = error;
      hostState[index].downUntil = Date.now() + HOST_COOLDOWN_MS;
    }
  }

  throw lastError || new Error("binance_unreachable");
}

function toCandle(row) {
  return {
    time: Math.floor(Number(row[0]) / 1000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
}

export async function getHistory(symbol, interval, limit) {
  const ttl = interval === "1m" ? 5 : interval === "5m" ? 15 : 60;

  return cachedJson(`${CACHE_ORIGIN}/history/${symbol}/${interval}/${limit}`, ttl, async () => {
    try {
      const rows = await binanceFetch(
        `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
      );
      const candles = rows
        .map(toCandle)
        .filter((candle) => Number.isFinite(candle.close) && candle.close > 0);

      if (candles.length < 2) throw new Error("empty_history");

      return { symbol, interval, source: "binance", candles };
    } catch {
      return {
        symbol,
        interval,
        source: "synthetic",
        candles: syntheticHistory(symbol, interval, limit),
      };
    }
  });
}

function mapTicker(row) {
  return {
    price: Number(row.lastPrice),
    changePct: Number(row.priceChangePercent),
    high: Number(row.highPrice),
    low: Number(row.lowPrice),
    volume: Number(row.quoteVolume),
  };
}

export async function getTicker(symbol) {
  return cachedJson(`${CACHE_ORIGIN}/ticker/${symbol}`, 5, async () => {
    try {
      const row = await binanceFetch(`/api/v3/ticker/24hr?symbol=${symbol}`);
      return { symbol, source: "binance", ...mapTicker(row) };
    } catch {
      return { symbol, source: "synthetic", ...syntheticTicker(symbol) };
    }
  });
}

export async function getTickers(symbols) {
  const key = symbols.join(",");

  return cachedJson(`${CACHE_ORIGIN}/tickers/${key}`, 10, async () => {
    try {
      const query = encodeURIComponent(JSON.stringify(symbols));
      const rows = await binanceFetch(`/api/v3/ticker/24hr?symbols=${query}`);
      const bySymbol = new Map(rows.map((row) => [row.symbol, row]));

      const tickers = symbols.map((symbol) => {
        const row = bySymbol.get(symbol);
        return row
          ? { symbol, source: "binance", ...mapTicker(row) }
          : { symbol, source: "synthetic", ...syntheticTicker(symbol) };
      });

      const allBinance = tickers.every((ticker) => ticker.source === "binance");
      return { tickers, source: allBinance ? "binance" : "mixed" };
    } catch {
      return {
        tickers: symbols.map((symbol) => ({
          symbol,
          source: "synthetic",
          ...syntheticTicker(symbol),
        })),
        source: "synthetic",
      };
    }
  });
}

/* --------------------------------------------------------------------------
 * Deterministic synthetic fallback.
 * Used when Binance is unreachable (region blocks, rate limits, outages).
 * Prices are a smooth function of time, so refetching the same candle always
 * returns the same value and the chart never "jumps".
 * ------------------------------------------------------------------------ */

function hash(text) {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function noise(seed) {
  return (hash(seed) % 2000) / 1000 - 1;
}

function basePrice(symbol) {
  return BASE_PRICES[symbol] ?? 0.5 + (hash(symbol) % 5000) / 100;
}

function priceAt(symbol, seconds) {
  const base = basePrice(symbol);
  const phase = (hash(`${symbol}:phase`) % 628) / 100;
  const daily = Math.sin((seconds / 86400) * Math.PI * 2 + phase) * 0.035;
  const hourly = Math.sin((seconds / 3600) * Math.PI * 2 + phase * 1.7) * 0.012;
  const fast = Math.sin((seconds / 300) * Math.PI * 2 + phase * 2.3) * 0.004;
  const jitter = noise(`${symbol}:${Math.floor(seconds / 60)}`) * 0.0015;

  return base * (1 + daily + hourly + fast + jitter);
}

function roundPrice(value) {
  if (value >= 1000) return Math.round(value * 100) / 100;
  if (value >= 1) return Math.round(value * 10000) / 10000;
  return Math.round(value * 1e8) / 1e8;
}

function syntheticHistory(symbol, interval, limit) {
  const stepMs = INTERVALS[interval];
  const stepSec = stepMs / 1000;
  const end = Math.floor(Date.now() / stepMs) * stepMs;
  const candles = [];

  for (let i = limit - 1; i >= 0; i--) {
    const time = Math.floor((end - i * stepMs) / 1000);
    const open = priceAt(symbol, time);
    const close = priceAt(symbol, time + stepSec);
    const wick = 0.0008 + ((hash(`${symbol}:w${time}`) % 1000) / 1000) * 0.0025;
    const high = Math.max(open, close) * (1 + wick);
    const low = Math.min(open, close) * (1 - wick * 0.9);
    const volume = 50 + (hash(`${symbol}:v${time}`) % 100000) / 100;

    candles.push({
      time,
      open: roundPrice(open),
      high: roundPrice(high),
      low: roundPrice(low),
      close: roundPrice(close),
      volume: Math.round(volume),
    });
  }

  return candles;
}

function syntheticTicker(symbol) {
  const now = Math.floor(Date.now() / 1000);
  const price = priceAt(symbol, now);
  const dayAgo = priceAt(symbol, now - 86400);
  let high = price;
  let low = price;

  for (let i = 0; i <= 24; i++) {
    const sample = priceAt(symbol, now - i * 3600);
    if (sample > high) high = sample;
    if (sample < low) low = sample;
  }

  return {
    price: roundPrice(price),
    changePct: Math.round((price / dayAgo - 1) * 10000) / 100,
    high: roundPrice(high),
    low: roundPrice(low),
    volume: Math.round(50000 + (hash(`${symbol}:${now}`) % 900000)),
  };
}

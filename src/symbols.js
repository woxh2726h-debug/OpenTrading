import { cachedJson, resolveUpstream, upstreamJson } from "./market.js";

const CACHE_KEY = "https://cache.opentrading.internal/v3/symbols";

const POPULAR = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "TONUSDT",
  "DOTUSDT",
  "SUIUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "TRXUSDT",
  "NEARUSDT",
  "APTUSDT",
  "ARBUSDT",
  "OPUSDT",
  "PEPEUSDT",
  "SHIBUSDT",
  "UNIUSDT",
  "ATOMUSDT",
  "FILUSDT",
  "INJUSDT",
  "SEIUSDT",
  "TIAUSDT",
  "FETUSDT",
  "WIFUSDT",
  "RNDRUSDT",
];

const STABLES = new Set([
  "USDC",
  "FDUSD",
  "TUSD",
  "BUSD",
  "DAI",
  "USDP",
  "USDD",
  "AEUR",
  "EUR",
  "GBP",
]);

const POPULAR_INDEX = new Map(POPULAR.map((symbol, index) => [symbol, index]));

const FALLBACK_SYMBOLS = POPULAR.map((symbol) => ({
  symbol,
  base: symbol.slice(0, -4),
  quote: "USDT",
}));

// Binance says "TRADING", MEXC says "1": both mean the market is live.
const ONLINE_STATUSES = new Set(["TRADING", "1", "ENABLED", "ONLINE"]);

function toInfo(symbol, base, quote) {
  return { symbol, base, quote };
}

function sortSymbols(list) {
  return list.sort((a, b) => {
    const aIndex = POPULAR_INDEX.has(a.symbol) ? POPULAR_INDEX.get(a.symbol) : 1000;
    const bIndex = POPULAR_INDEX.has(b.symbol) ? POPULAR_INDEX.get(b.symbol) : 1000;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return a.symbol.localeCompare(b.symbol);
  });
}

function isUsable(item) {
  if (!item) return false;
  if (!ONLINE_STATUSES.has(String(item.status || "").toUpperCase())) return false;
  if (item.isSpotTradingAllowed === false) return false;
  if (String(item.quoteAsset || "").toUpperCase() !== "USDT") return false;

  const base = String(item.baseAsset || "");
  if (!base || STABLES.has(base)) return false;
  if (/(UP|DOWN|BULL|BEAR)$/.test(base)) return false;

  return /^[A-Z0-9]{2,12}USDT$/.test(String(item.symbol || ""));
}

async function fetchExchangeInfo() {
  const { data, provider } = await resolveUpstream((upstream, timeout) =>
    upstreamJson(upstream, "/api/v3/exchangeInfo", Math.max(timeout, 8000)),
  );

  if (!data || !Array.isArray(data.symbols)) throw new Error("bad_exchange_info");

  const seen = new Set();
  const list = [];

  for (const item of data.symbols) {
    if (!isUsable(item)) continue;

    const symbol = String(item.symbol);
    if (seen.has(symbol)) continue;

    seen.add(symbol);
    list.push(toInfo(symbol, String(item.baseAsset), "USDT"));
  }

  if (list.length < 10) throw new Error("too_few_symbols");
  return { symbols: list, provider: provider.id };
}

export async function getSymbolList() {
  return cachedJson(CACHE_KEY, 3600, async () => {
    try {
      const { symbols, provider } = await fetchExchangeInfo();
      return { symbols: sortSymbols(symbols), source: provider };
    } catch {
      return { symbols: FALLBACK_SYMBOLS.slice(), source: "fallback" };
    }
  });
}

export function searchSymbols(symbols, query, limit) {
  const normalized = String(query || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!normalized) return symbols.slice(0, limit);

  const matches = [];

  for (const item of symbols) {
    let score = -1;

    if (item.symbol === normalized) score = 0;
    else if (item.symbol.startsWith(normalized)) score = 1;
    else if (item.base.startsWith(normalized)) score = 2;
    else if (item.symbol.includes(normalized) || item.base.includes(normalized)) score = 3;

    if (score >= 0) matches.push({ score, item });
  }

  matches.sort(
    (a, b) => a.score - b.score || a.item.symbol.localeCompare(b.item.symbol),
  );

  return matches.slice(0, limit).map((match) => match.item);
}

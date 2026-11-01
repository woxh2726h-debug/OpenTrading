import { bollinger, ema, macd, rsi, sma } from "./lib/indicators.js";

const TIMEFRAMES = {
  "1m": "1м",
  "5m": "5м",
  "15m": "15м",
  "1h": "1ч",
  "4h": "4ч",
  "1d": "1д",
  "1w": "1н",
};

const DEFAULT_WATCHLIST = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"];

const INDICATORS = [
  { id: "volume", label: "Объём" },
  { id: "sma20", label: "SMA 20" },
  { id: "sma50", label: "SMA 50" },
  { id: "ema50", label: "EMA 50" },
  { id: "bb", label: "Bollinger Bands (20, 2)" },
  { id: "rsi", label: "RSI 14" },
  { id: "macd", label: "MACD (12, 26, 9)" },
];

const SETTINGS_KEY = "ot.settings.v1";
const WATCHLIST_KEY = "ot.watchlist.v1";
const HISTORY_LIMIT = 600;
const VOL_UP = "rgba(38, 166, 154, 0.32)";
const VOL_DOWN = "rgba(239, 83, 80, 0.32)";

const state = {
  symbol: "BTCUSDT",
  interval: "1m",
  theme: "dark",
  timezone: "local",
  candles: [],
  candleByTime: new Map(),
  indicators: {
    volume: true,
    sma20: true,
    sma50: false,
    ema50: false,
    bb: false,
    rsi: false,
    macd: false,
  },
  watchlist: DEFAULT_WATCHLIST.slice(),
  quotes: new Map(),
  watchlistMode: "local",
  LC: null,
  chart: null,
  series: {},
  resizeObserver: null,
  ws: null,
  wsAttempt: 0,
  pollTimer: null,
  reconnectTimer: null,
  source: "—",
  conn: "idle",
};

const el = {};
let searchTimer = null;
let searchToken = 0;
let searchResults = [];
let searchIndex = 0;

/* ------------------------------------------------------------------ boot */

async function boot() {
  cacheElements();
  loadSettings();
  applyTheme();
  renderIndicators();
  renderWatchlist();
  bindUi();
  updateSymbolLabels();
  updateTimeframeButtons();
  updateClock();
  window.setInterval(updateClock, 1000);

  try {
    state.LC = await waitForLibrary();
  } catch {
    showLoading(false);
    showError("Не удалось загрузить библиотеку графиков. Обновите страницу.");
    return;
  }

  await loadHistory();
  connectStream();
  refreshQuotes();
  window.setInterval(refreshQuotes, 15000);
  syncServerWatchlist();
}

function cacheElements() {
  const ids = [
    "sidebar",
    "sidebarToggle",
    "symbolBtn",
    "symbolName",
    "symbolMeta",
    "tfGroup",
    "indicatorsBtn",
    "themeBtn",
    "themeIcon",
    "addSymbolBtn",
    "watchlist",
    "chartSymbol",
    "chartTf",
    "sourceBadge",
    "ohlc",
    "chartHost",
    "chart",
    "chartLoading",
    "chartError",
    "chartErrorText",
    "retryBtn",
    "connDot",
    "connLabel",
    "statusSymbol",
    "statusSource",
    "clock",
    "searchModal",
    "searchInput",
    "searchResults",
    "indicatorsModal",
    "indList",
    "closeIndicators",
    "toast",
  ];

  for (const id of ids) el[id] = document.getElementById(id);
}

/* --------------------------------------------------------------- storage */

const store = {
  get(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage can be unavailable in private mode; the app still works.
    }
  },
};

function loadSettings() {
  const saved = store.get(SETTINGS_KEY, null);

  if (saved && typeof saved === "object") {
    if (typeof saved.symbol === "string" && /^[A-Z0-9]{4,20}$/.test(saved.symbol)) {
      state.symbol = saved.symbol;
    }
    if (typeof saved.interval === "string" && TIMEFRAMES[saved.interval]) {
      state.interval = saved.interval;
    }
    if (saved.indicators && typeof saved.indicators === "object") {
      for (const indicator of INDICATORS) {
        if (typeof saved.indicators[indicator.id] === "boolean") {
          state.indicators[indicator.id] = saved.indicators[indicator.id];
        }
      }
    }
    if (saved.theme === "light" || saved.theme === "dark") {
      state.theme = saved.theme;
    }
    if (saved.timezone === "local" || saved.timezone === "utc") {
      state.timezone = saved.timezone;
    }
  }

  const savedList = store.get(WATCHLIST_KEY, null);

  if (Array.isArray(savedList) && savedList.length) {
    const list = savedList
      .filter((item) => typeof item === "string" && /^[A-Z0-9]{4,20}$/.test(item))
      .slice(0, 50);

    if (list.length) state.watchlist = list;
  }

  if (!state.watchlist.includes(state.symbol)) state.watchlist.unshift(state.symbol);
}

function saveSettings() {
  store.set(SETTINGS_KEY, {
    symbol: state.symbol,
    interval: state.interval,
    theme: state.theme,
    timezone: state.timezone,
    indicators: state.indicators,
  });
}

function persistWatchlist() {
  store.set(WATCHLIST_KEY, state.watchlist);
}

/* ------------------------------------------------------------ formatting */

function fmtPrice(value) {
  if (!Number.isFinite(value)) return "—";

  const absolute = Math.abs(value);
  const digits = absolute >= 1000 ? 2 : absolute >= 1 ? 2 : absolute >= 0.01 ? 4 : 6;

  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtPct(value) {
  if (!Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function precisionFor(price) {
  const absolute = Math.abs(price || 0);
  if (absolute >= 1000) return 2;
  if (absolute >= 1) return 4;
  return 6;
}

function toCandleData(candle, time = chartTime(candle.time)) {
  return {
    time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  };
}

function normalizeCandle(candle) {
  return {
    time: Number(candle.time),
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: Number(candle.volume) || 0,
  };
}

function lastCandle() {
  return state.candles.length ? state.candles[state.candles.length - 1] : null;
}

/* -------------------------------------------------------------- timezone */

const INTRADAY_INTERVALS = new Set(["1m", "5m", "15m", "1h", "4h"]);

// The zone the operating system reports: the same one behind the taskbar clock.
const LOCAL_TIME_ZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

const zoneFormatters = new Map();

function zoneFormatter(zone, options) {
  const key = `${zone}\u0000${JSON.stringify(options)}`;
  let formatter = zoneFormatters.get(key);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat("ru-RU", { ...options, timeZone: zone });
    zoneFormatters.set(key, formatter);
  }

  return formatter;
}

function formatInZone(zone, date, options) {
  try {
    return zoneFormatter(zone, options).format(date);
  } catch {
    return date.toISOString().slice(11, 19);
  }
}

// Minutes east of UTC for `zone` at `date`, DST included.
function zoneOffsetMinutes(zone, date) {
  if (zone === "UTC") return 0;

  try {
    const parts = zoneFormatter(zone, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);

    const pick = (type) => Number(parts.find((part) => part.type === type)?.value);
    const wallClock = Date.UTC(
      pick("year"),
      pick("month") - 1,
      pick("day"),
      pick("hour"),
      pick("minute"),
      pick("second"),
    );

    return Math.round((wallClock - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  } catch {
    return 0;
  }
}

function zoneOffsetLabel(zone, date) {
  const minutes = zoneOffsetMinutes(zone, date);
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const rest = String(absolute % 60).padStart(2, "0");

  return `UTC${sign}${hours}:${rest}`;
}

function activeTimeZone() {
  return state.timezone === "utc" ? "UTC" : LOCAL_TIME_ZONE;
}

function isIntradayInterval(interval = state.interval) {
  return INTRADAY_INTERVALS.has(interval);
}

// Intraday candles are shown in the chosen zone; daily and weekly candles keep
// their UTC dates so a bar keeps the business day its exchange assigned to it.
function usesLocalTime() {
  return state.timezone !== "utc" && isIntradayInterval();
}

const offsetCache = new Map();

// Offset of the system zone at `timeSeconds`, cached per hour (DST aware).
function localOffsetSeconds(timeSeconds) {
  const bucket = Math.floor(timeSeconds / 3600);
  let offset = offsetCache.get(bucket);

  if (offset === undefined) {
    offset = zoneOffsetMinutes(LOCAL_TIME_ZONE, new Date(bucket * 3600 * 1000)) * 60;
    if (offsetCache.size > 2048) offsetCache.clear();
    offsetCache.set(bucket, offset);
  }

  return offset;
}

/*
 * lightweight-charts only ever speaks UTC, so local display is done by shifting
 * intraday timestamps by the zone offset. A candle keeps its real identity in
 * `state.candles`; only the value handed to the chart changes, which makes the
 * chart's "midnight" the user's midnight and keeps tick marks aligned.
 */
function chartTime(timeSeconds) {
  return usesLocalTime() ? timeSeconds + localOffsetSeconds(timeSeconds) : timeSeconds;
}

// Same mapping for a whole ascending series. When DST falls back, one wall-clock
// hour repeats, so duplicates are nudged by a second to keep times ascending.
function chartTimes(candles) {
  const times = new Array(candles.length);
  let previous = -Infinity;

  for (let i = 0; i < candles.length; i++) {
    let time = chartTime(candles[i].time);
    if (time <= previous) time = previous + 1;
    times[i] = time;
    previous = time;
  }

  return times;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function utcClock(date, withSeconds = false) {
  const base = `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
  return withSeconds ? `${base}:${pad2(date.getUTCSeconds())}` : base;
}

function utcDate(date, shortYear = false) {
  const year = shortYear ? String(date.getUTCFullYear()).slice(2) : date.getUTCFullYear();
  return `${pad2(date.getUTCDate())}.${pad2(date.getUTCMonth() + 1)}.${year}`;
}

function formatTickMark(time, tickMarkType) {
  if (typeof time !== "number") return String(time ?? "");

  const date = new Date(time * 1000);

  switch (tickMarkType) {
    case 0: // year
      return String(date.getUTCFullYear());
    case 1: // month
      return formatInZone("UTC", date, { month: "short" });
    case 2: // day of month
      return formatInZone("UTC", date, { day: "numeric", month: "short" });
    case 4: // time with seconds
      return utcClock(date, true);
    case 3: // time
      return utcClock(date);
    default:
      return isIntradayInterval() ? utcClock(date) : utcDate(date);
  }
}

function formatCrosshairTime(time) {
  if (typeof time !== "number") return String(time ?? "");

  const date = new Date(time * 1000);
  return isIntradayInterval()
    ? `${utcDate(date, true)} ${utcClock(date)}`
    : utcDate(date);
}

/* ----------------------------------------------------------------- chart */

function waitForLibrary(timeout = 10000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();

    const check = () => {
      if (window.LightweightCharts) {
        resolve(window.LightweightCharts);
        return;
      }
      if (Date.now() - started > timeout) {
        reject(new Error("lightweight_charts_missing"));
        return;
      }
      window.setTimeout(check, 50);
    };

    check();
  });
}

function cssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function chartColors() {
  return {
    bg: cssVar("--chart-bg", "#080b11"),
    text: cssVar("--text-dim", "#63708a"),
    grid: cssVar("--chart-grid", "rgba(255,255,255,.035)"),
    border: cssVar("--border", "#222b3a"),
    up: cssVar("--up", "#26a69a"),
    down: cssVar("--down", "#ef5350"),
    accent: cssVar("--accent", "#3b82f6"),
    info: cssVar("--info", "#4da3ff"),
    warn: cssVar("--warn", "#f5a623"),
    rsi: "#b58cff",
    muted: cssVar("--text-dim", "#63708a"),
  };
}

function destroyChart() {
  if (state.resizeObserver) {
    state.resizeObserver.disconnect();
    state.resizeObserver = null;
  }
  if (state.chart) {
    state.chart.remove();
    state.chart = null;
  }
  state.series = {};
}

function renderChart() {
  if (!state.LC || !state.candles.length) return;

  destroyChart();

  const LC = state.LC;
  const colors = chartColors();
  const host = el.chart;
  const width = host.clientWidth || 800;
  const height = host.clientHeight || 420;

  const chart = LC.createChart(host, {
    width,
    height,
    layout: {
      background: { type: LC.ColorType.Solid, color: colors.bg },
      textColor: colors.text,
      fontFamily: "Inter, Segoe UI, system-ui, sans-serif",
      fontSize: 11,
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: colors.grid },
      horzLines: { color: colors.grid },
    },
    rightPriceScale: {
      borderColor: colors.border,
      scaleMargins: { top: 0.08, bottom: 0.08 },
    },
    timeScale: {
      borderColor: colors.border,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 4,
      barSpacing: 7,
      tickMarkFormatter: formatTickMark,
    },
    crosshair: {
      mode: LC.CrosshairMode.Normal,
      vertLine: { color: colors.border, labelBackgroundColor: colors.accent },
      horzLine: { color: colors.border, labelBackgroundColor: colors.accent },
    },
    localization: { locale: "ru-RU", timeFormatter: formatCrosshairTime },
  });

  const times = chartTimes(state.candles);

  state.chart = chart;
  state.candleByTime = new Map(
    state.candles.map((candle, index) => [times[index], candle]),
  );

  const candleSeries = chart.addSeries(LC.CandlestickSeries, {
    upColor: colors.up,
    downColor: colors.down,
    borderVisible: false,
    wickUpColor: colors.up,
    wickDownColor: colors.down,
    priceLineColor: colors.accent,
  });

  const digits = precisionFor(lastCandle() ? lastCandle().close : 1);
  candleSeries.applyOptions({
    priceFormat: { type: "price", precision: digits, minMove: 1 / 10 ** digits },
  });
  candleSeries.setData(state.candles.map((candle, index) => toCandleData(candle, times[index])));

  state.series.candle = candleSeries;

  buildIndicatorSeries(chart, colors, times);

  chart.timeScale().setVisibleLogicalRange({
    from: Math.max(0, state.candles.length - 160),
    to: state.candles.length + 4,
  });

  chart.subscribeCrosshairMove((param) => {
    if (!param || !param.time) {
      setOhlc(lastCandle());
      return;
    }
    setOhlc(state.candleByTime.get(param.time) || lastCandle());
  });

  const observer = new ResizeObserver(() => {
    if (!state.chart) return;
    const nextWidth = host.clientWidth;
    const nextHeight = host.clientHeight;
    if (nextWidth > 0 && nextHeight > 0) state.chart.resize(nextWidth, nextHeight);
  });
  observer.observe(host);
  state.resizeObserver = observer;

  setOhlc(lastCandle());
}

function ensurePane(chart, index) {
  while (chart.panes().length <= index) chart.addPane();
}

function buildIndicatorSeries(chart, colors, times) {
  const LC = state.LC;
  const closes = state.candles.map((candle) => candle.close);
  const s = state.series;
  let pane = 1;

  if (state.indicators.volume) {
    const volume = chart.addSeries(LC.HistogramSeries, {
      priceScaleId: "",
      priceFormat: { type: "volume" },
      priceLineVisible: false,
      lastValueVisible: false,
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volume.setData(volumeData(times));
    s.volume = volume;
  }

  const addLine = (color, width, title, paneIndex = 0, lineStyle = LC.LineStyle.Solid) =>
    chart.addSeries(
      LC.LineSeries,
      {
        color,
        lineWidth: width,
        title,
        lineStyle,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      },
      paneIndex,
    );

  if (state.indicators.sma20) {
    s.sma20 = addLine(colors.info, 2, "SMA 20");
    s.sma20.setData(lineData(times, sma(closes, 20)));
  }

  if (state.indicators.sma50) {
    s.sma50 = addLine(colors.warn, 2, "SMA 50");
    s.sma50.setData(lineData(times, sma(closes, 50)));
  }

  if (state.indicators.ema50) {
    s.ema50 = addLine(colors.accent, 2, "EMA 50");
    s.ema50.setData(lineData(times, ema(closes, 50)));
  }

  if (state.indicators.bb) {
    const bands = bollinger(closes, 20, 2);
    s.bbUpper = addLine(colors.info, 1, "BB upper");
    s.bbLower = addLine(colors.info, 1, "BB lower");
    s.bbMiddle = addLine(colors.muted, 1, "BB basis", 0, LC.LineStyle.Dotted);
    s.bbUpper.setData(lineData(times, bands.upper));
    s.bbLower.setData(lineData(times, bands.lower));
    s.bbMiddle.setData(lineData(times, bands.middle));
  }

  if (state.indicators.rsi) {
    ensurePane(chart, pane);
    s.rsi = addLine(colors.rsi, 2, "RSI 14", pane);
    s.rsi.setData(lineData(times, rsi(closes, 14)));
    s.rsi.applyOptions({
      autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
    });
    s.rsi.createPriceLine({
      price: 70,
      color: colors.border,
      lineWidth: 1,
      lineStyle: LC.LineStyle.Dashed,
      axisLabelVisible: false,
      title: "",
    });
    s.rsi.createPriceLine({
      price: 30,
      color: colors.border,
      lineWidth: 1,
      lineStyle: LC.LineStyle.Dashed,
      axisLabelVisible: false,
      title: "",
    });
    pane += 1;
  }

  if (state.indicators.macd) {
    ensurePane(chart, pane);
    const result = macd(closes, 12, 26, 9);

    s.macdHist = chart.addSeries(
      LC.HistogramSeries,
      { priceLineVisible: false, lastValueVisible: false },
      pane,
    );
    s.macdHist.setData(histogramData(times, result.histogram));

    s.macd = addLine(colors.info, 2, "MACD", pane);
    s.macdSignal = addLine(colors.warn, 2, "Signal", pane);
    s.macd.setData(lineData(times, result.macd));
    s.macdSignal.setData(lineData(times, result.signal));

    pane += 1;
  }

  const panes = chart.panes();
  if (panes.length > 1) {
    panes[0].setStretchFactor(1);

    let index = 1;
    if (state.indicators.rsi && panes[index]) {
      panes[index].setStretchFactor(0.28);
      index += 1;
    }
    if (state.indicators.macd && panes[index]) {
      panes[index].setStretchFactor(0.32);
    }
  }
}

function lineData(times, values) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value != null && Number.isFinite(value)) out.push({ time: times[i], value });
  }
  return out;
}

function histogramData(times, values) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value == null || !Number.isFinite(value)) continue;
    out.push({
      time: times[i],
      value,
      color: value >= 0 ? "rgba(38, 166, 154, 0.55)" : "rgba(239, 83, 80, 0.55)",
    });
  }
  return out;
}

function volumeData(times = chartTimes(state.candles)) {
  return state.candles.map((candle, index) => ({
    time: times[index],
    value: candle.volume || 0,
    color: candle.close >= candle.open ? VOL_UP : VOL_DOWN,
  }));
}

function updateIndicators() {
  if (!state.chart) return;

  const s = state.series;
  const times = chartTimes(state.candles);
  const closes = state.candles.map((candle) => candle.close);

  if (s.volume) s.volume.setData(volumeData(times));
  if (s.sma20) s.sma20.setData(lineData(times, sma(closes, 20)));
  if (s.sma50) s.sma50.setData(lineData(times, sma(closes, 50)));
  if (s.ema50) s.ema50.setData(lineData(times, ema(closes, 50)));

  if (s.bbUpper && s.bbLower && s.bbMiddle) {
    const bands = bollinger(closes, 20, 2);
    s.bbUpper.setData(lineData(times, bands.upper));
    s.bbLower.setData(lineData(times, bands.lower));
    s.bbMiddle.setData(lineData(times, bands.middle));
  }

  if (s.rsi) s.rsi.setData(lineData(times, rsi(closes, 14)));

  if (s.macd && s.macdSignal && s.macdHist) {
    const result = macd(closes, 12, 26, 9);
    s.macd.setData(lineData(times, result.macd));
    s.macdSignal.setData(lineData(times, result.signal));
    s.macdHist.setData(histogramData(times, result.histogram));
  }
}

/* ------------------------------------------------------------------ data */

async function getJson(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${path} → ${response.status}`);
  return response.json();
}

async function loadHistory() {
  showLoading(true);
  hideError();
  disconnectStream();

  try {
    const data = await getJson(
      `/api/history?symbol=${encodeURIComponent(state.symbol)}&interval=${state.interval}&limit=${HISTORY_LIMIT}`,
    );

    if (!data || !Array.isArray(data.candles) || data.candles.length < 2) {
      throw new Error("empty_history");
    }

    state.candles = data.candles.map(normalizeCandle);
    state.source = data.source;
    updateSourceBadge();
    renderChart();
    showLoading(false);
  } catch (error) {
    console.error(error);
    showLoading(false);
    showError("Не удалось загрузить историю. Проверьте соединение и попробуйте ещё раз.");
  }
}

/* -------------------------------------------------------------- realtime */

function connectStream() {
  disconnectStream();
  if (!state.candles.length) return;

  if (!isBinanceSource(state.source)) {
    startPolling();
    return;
  }

  const stream = `${state.symbol.toLowerCase()}@kline_${state.interval}`;
  const url = state.wsAttempt % 2 === 0
    ? `wss://stream.binance.com:9443/ws/${stream}`
    : `wss://stream.binance.com/ws/${stream}`;

  state.wsAttempt += 1;
  setConn("connecting");

  let socket;
  try {
    socket = new WebSocket(url);
  } catch {
    startPolling();
    return;
  }

  state.ws = socket;
  const openedAt = Date.now();

  socket.addEventListener("open", () => {
    if (state.ws !== socket) return;
    state.wsAttempt = 0;
    setConn("live");
    stopPolling();
  });

  socket.addEventListener("message", (event) => {
    if (state.ws !== socket) return;
    try {
      const message = JSON.parse(event.data);
      if (message && message.e === "kline" && message.k) applyKline(message.k);
    } catch {
      // Ignore malformed frames.
    }
  });

  socket.addEventListener("error", () => {
    try {
      socket.close();
    } catch {
      // Nothing else to do.
    }
  });

  socket.addEventListener("close", () => {
    if (state.ws !== socket) return;
    state.ws = null;
    startPolling();
    scheduleReconnect(Date.now() - openedAt > 10000 ? 4000 : 20000);
  });
}

function scheduleReconnect(delay) {
  if (state.reconnectTimer || !isBinanceSource(state.source)) return;

  state.reconnectTimer = window.setTimeout(() => {
    state.reconnectTimer = null;
    if (!state.ws && isBinanceSource(state.source)) connectStream();
  }, delay);
}

function disconnectStream() {
  if (state.ws) {
    const socket = state.ws;
    state.ws = null;
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }

  stopPolling();

  if (state.reconnectTimer) {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

function startPolling() {
  setConn(state.source === "synthetic" ? "synthetic" : "polling");
  if (state.pollTimer) return;
  state.pollTimer = window.setInterval(pollTick, 5000);
  pollTick();
}

function stopPolling() {
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function pollTick() {
  try {
    const data = await getJson(
      `/api/history?symbol=${encodeURIComponent(state.symbol)}&interval=${state.interval}&limit=3`,
    );

    if (data.source !== state.source) {
      state.source = data.source;
      updateSourceBadge();
    }

    applyTail(data.candles);
  } catch {
    // Keep the previous data and retry on the next tick.
  }
}

function applyKline(kline) {
  const time = Math.floor(Number(kline.t) / 1000);
  const candle = {
    time,
    open: Number(kline.o),
    high: Number(kline.h),
    low: Number(kline.l),
    close: Number(kline.c),
    volume: Number(kline.v),
  };

  if (!Number.isFinite(candle.close)) return;

  const candles = state.candles;
  const last = candles[candles.length - 1];

  if (!last || time > last.time) {
    candles.push(candle);
    if (candles.length > HISTORY_LIMIT * 2) candles.shift();
  } else if (time === last.time) {
    candles[candles.length - 1] = candle;
  } else {
    return;
  }

  const displayTime = chartTime(time);
  state.candleByTime.set(displayTime, candle);

  const s = state.series;
  if (s.candle) s.candle.update(toCandleData(candle));
  if (s.volume) {
    s.volume.update({
      time: displayTime,
      value: candle.volume,
      color: candle.close >= candle.open ? VOL_UP : VOL_DOWN,
    });
  }

  updateIndicators();
  setOhlc(candle);
  updateActivePrice(candle.close);
}

function applyTail(candles) {
  if (!Array.isArray(candles) || !candles.length) return;

  const incoming = candles.map(normalizeCandle);
  const latest = incoming[incoming.length - 1];
  const last = state.candles[state.candles.length - 1];

  if (!last || latest.time > last.time) {
    for (const candle of incoming) {
      if (!state.candles.some((item) => item.time === candle.time)) state.candles.push(candle);
    }
    state.candles.sort((a, b) => a.time - b.time);
  } else {
    for (const candle of incoming) {
      const index = state.candles.findIndex((item) => item.time === candle.time);
      if (index >= 0) state.candles[index] = candle;
    }
  }

  const times = chartTimes(state.candles);
  state.candleByTime = new Map(
    state.candles.map((candle, index) => [times[index], candle]),
  );

  if (state.series.candle) {
    state.series.candle.setData(
      state.candles.map((candle, index) => toCandleData(candle, times[index])),
    );
  }

  updateIndicators();
  setOhlc(latest);
  updateActivePrice(latest.close);
}

/* -------------------------------------------------------------- watchlist */

function renderWatchlist() {
  el.watchlist.innerHTML = "";

  for (const symbol of state.watchlist) {
    el.watchlist.appendChild(watchlistRow(symbol));
  }
}

function watchlistRow(symbol) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "wl-row" + (symbol === state.symbol ? " active" : "");
  row.dataset.symbol = symbol;

  const base = symbol.replace(/USDT$/, "");

  row.innerHTML =
    `<span class="wl-symbol"><span class="wl-base">${base}</span><span class="wl-quote">USDT</span></span>` +
    `<span class="wl-price" data-price>—</span>` +
    `<span class="wl-change" data-change>—</span>` +
    `<span class="wl-remove" role="button" aria-label="Удалить ${symbol}" title="Удалить">×</span>`;

  row.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest(".wl-remove")) {
      event.stopPropagation();
      removeSymbol(symbol);
      return;
    }
    setSymbol(symbol);
  });

  const quote = state.quotes.get(symbol);
  if (quote) fillQuote(row, quote);

  return row;
}

function fillQuote(row, quote) {
  const price = row.querySelector("[data-price]");
  const change = row.querySelector("[data-change]");

  if (price) price.textContent = fmtPrice(quote.price);
  if (change) {
    change.textContent = fmtPct(quote.changePct);
    change.classList.toggle("up", quote.changePct >= 0);
    change.classList.toggle("down", quote.changePct < 0);
  }
}

async function refreshQuotes() {
  if (!state.watchlist.length) return;

  try {
    const data = await getJson(
      `/api/tickers?symbols=${encodeURIComponent(state.watchlist.join(","))}`,
    );

    for (const quote of data.tickers || []) state.quotes.set(quote.symbol, quote);

    for (const row of el.watchlist.querySelectorAll(".wl-row")) {
      const quote = state.quotes.get(row.dataset.symbol);
      if (quote) fillQuote(row, quote);
    }

    const active = state.quotes.get(state.symbol);
    if (active) updateActivePrice(active.price);
  } catch {
    // Quotes are best effort; the chart keeps working without them.
  }
}

function updateActivePrice(price) {
  if (!Number.isFinite(price)) return;

  const quote = state.quotes.get(state.symbol);
  if (quote) quote.price = price;

  const node = el.watchlist.querySelector(
    `.wl-row[data-symbol="${state.symbol}"] [data-price]`,
  );
  if (node) node.textContent = fmtPrice(price);
}

async function addSymbol(symbol) {
  if (!symbol) return;

  if (!state.watchlist.includes(symbol)) {
    state.watchlist.push(symbol);
    persistWatchlist();
    renderWatchlist();
    refreshQuotes();

    if (state.watchlistMode === "d1") {
      fetch("/api/watchlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol }),
      }).catch(() => {});
    }
  }

  await setSymbol(symbol);
  closeSidebar();
}

async function removeSymbol(symbol) {
  state.watchlist = state.watchlist.filter((item) => item !== symbol);
  persistWatchlist();
  renderWatchlist();
  state.quotes.delete(symbol);

  if (state.watchlistMode === "d1") {
    fetch(`/api/watchlist/${encodeURIComponent(symbol)}`, { method: "DELETE" }).catch(() => {});
  }

  if (symbol === state.symbol && state.watchlist.length) {
    await setSymbol(state.watchlist[0]);
  }
}

async function syncServerWatchlist() {
  try {
    const response = await fetch("/api/watchlist");
    if (!response.ok) return;

    const data = await response.json();
    if (!data || data.storage !== "d1") return;

    state.watchlistMode = "d1";

    if (Array.isArray(data.symbols) && data.symbols.length) {
      state.watchlist = data.symbols;
      persistWatchlist();
      renderWatchlist();
      refreshQuotes();
      return;
    }

    await Promise.all(
      state.watchlist.map((symbol) =>
        fetch("/api/watchlist", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ symbol }),
        }).catch(() => null),
      ),
    );
  } catch {
    // No D1 binding: stick with localStorage.
  }
}

/* --------------------------------------------------------------- symbols */

async function setSymbol(symbol) {
  if (!symbol || symbol === state.symbol) {
    closeSidebar();
    return;
  }

  state.symbol = symbol;
  saveSettings();
  updateSymbolLabels();
  updateTimeframeButtons();
  await loadHistory();
  connectStream();
  refreshQuotes();
}

async function changeInterval(interval) {
  if (!TIMEFRAMES[interval] || interval === state.interval) return;

  state.interval = interval;
  saveSettings();
  updateSymbolLabels();
  updateTimeframeButtons();
  await loadHistory();
  connectStream();
}

function updateSymbolLabels() {
  const base = state.symbol.replace(/USDT$/, "");

  el.symbolName.textContent = `${base} / USDT`;
  el.chartSymbol.textContent = state.symbol;
  el.chartTf.textContent = TIMEFRAMES[state.interval] || state.interval;
  el.statusSymbol.textContent = `${state.symbol} · ${TIMEFRAMES[state.interval] || state.interval}`;
  document.title = `${state.symbol} ${state.interval} — OpenTrading`;
}

function updateTimeframeButtons() {
  for (const button of el.tfGroup.querySelectorAll("button[data-tf]")) {
    button.classList.toggle("active", button.dataset.tf === state.interval);
  }
}

function setOhlc(candle) {
  if (!candle) {
    el.ohlc.innerHTML = "";
    return;
  }

  const change = candle.open ? ((candle.close - candle.open) / candle.open) * 100 : 0;
  const direction = change >= 0 ? "up" : "down";

  el.ohlc.innerHTML =
    `<span>O <b>${fmtPrice(candle.open)}</b></span>` +
    `<span>H <b>${fmtPrice(candle.high)}</b></span>` +
    `<span>L <b>${fmtPrice(candle.low)}</b></span>` +
    `<span>C <b>${fmtPrice(candle.close)}</b></span>` +
    `<span class="${direction}">${fmtPct(change)}</span>`;
}

/* ---------------------------------------------------------------- search */

function openSearch() {
  el.searchModal.classList.remove("hidden");
  el.searchInput.value = "";
  window.setTimeout(() => el.searchInput.focus(), 20);
  runSearch("");
}

function closeSearch() {
  el.searchModal.classList.add("hidden");
}

async function runSearch(query) {
  const token = ++searchToken;

  try {
    const data = await getJson(
      `/api/symbols?q=${encodeURIComponent(query)}&limit=40`,
    );
    if (token !== searchToken) return;

    searchResults = Array.isArray(data.symbols) ? data.symbols : [];
    searchIndex = 0;
    renderSearchResults();
  } catch {
    if (token !== searchToken) return;
    searchResults = [];
    el.searchResults.innerHTML = '<div class="search-empty">Не удалось загрузить символы</div>';
  }
}

function renderSearchResults() {
  if (!searchResults.length) {
    el.searchResults.innerHTML = '<div class="search-empty">Ничего не найдено</div>';
    return;
  }

  el.searchResults.innerHTML = "";

  searchResults.forEach((item, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "search-row" + (index === searchIndex ? " active" : "");
    row.innerHTML =
      `<span class="search-symbol">${item.base}<span>/${item.quote}</span></span>` +
      `<span class="search-full">${item.symbol}</span>`;

    row.addEventListener("click", () => chooseSearchResult(item.symbol));
    row.addEventListener("mousemove", () => {
      if (searchIndex !== index) {
        searchIndex = index;
        renderSearchResults();
      }
    });

    el.searchResults.appendChild(row);
  });
}

function chooseSearchResult(symbol) {
  closeSearch();
  addSymbol(symbol);
}

/* ------------------------------------------------------------ indicators */

function renderIndicators() {
  el.indList.innerHTML = "";

  for (const indicator of INDICATORS) {
    const label = document.createElement("label");
    label.className = "ind-row";
    label.innerHTML =
      `<input type="checkbox" data-ind="${indicator.id}" ${state.indicators[indicator.id] ? "checked" : ""} />` +
      `<span>${indicator.label}</span>`;

    const input = label.querySelector("input");
    input.addEventListener("change", () => {
      state.indicators[indicator.id] = input.checked;
      saveSettings();
      if (state.candles.length && state.LC) renderChart();
    });

    el.indList.appendChild(label);
  }
}

function openIndicators() {
  el.indicatorsModal.classList.remove("hidden");
}

function closeIndicatorsModal() {
  el.indicatorsModal.classList.add("hidden");
}

/* ----------------------------------------------------------------- theme */

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  el.themeIcon.textContent = state.theme === "dark" ? "☀" : "☾";
}

function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";
  saveSettings();
  applyTheme();
  if (state.candles.length && state.LC) renderChart();
}

/* ---------------------------------------------------------------- status */

function setConn(status) {
  state.conn = status;

  const labels = {
    live: ["LIVE", "ok"],
    connecting: ["CONNECTING", "idle"],
    polling: ["POLLING", "warn"],
    synthetic: ["DEMO DATA", "warn"],
    idle: ["IDLE", "idle"],
  };

  const [label, dot] = labels[status] || labels.idle;
  el.connLabel.textContent = label;
  el.connDot.className = `dot ${dot}`;
}

const SOURCE_LABELS = {
  binance: "BINANCE",
  "binance-vision": "BINANCE",
  "binance-api1": "BINANCE",
  "binance-api2": "BINANCE",
  "binance-us": "BINANCE US",
  mexc: "MEXC",
  mixed: "MIXED",
  synthetic: "SYNTHETIC",
};

function isBinanceSource(source) {
  return typeof source === "string" && source.startsWith("binance");
}

function sourceLabel(source) {
  return SOURCE_LABELS[source] || String(source || "").toUpperCase() || "—";
}

function updateSourceBadge() {
  const synthetic = state.source === "synthetic" || state.source === "mixed";

  el.sourceBadge.textContent = sourceLabel(state.source);
  el.sourceBadge.classList.toggle("synthetic", synthetic);
  el.statusSource.textContent =
    state.source === "synthetic"
      ? "источник: синтетика (fallback)"
      : state.source === "mixed"
        ? "источник: часть символов синтетическая"
        : `источник: ${sourceLabel(state.source)}`;

  el.symbolMeta.textContent =
    state.source === "synthetic"
      ? "демо-данные"
      : state.source === "mixed"
        ? "смешанный источник"
        : `${sourceLabel(state.source)} · спот`;
}

function updateClock() {
  const now = new Date();
  const zone = activeTimeZone();
  const time = formatInZone(zone, now, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const zoneLabel = zone === "UTC" ? "UTC" : zoneOffsetLabel(zone, now);

  el.clock.textContent = `${time} ${zoneLabel}`;
  el.clock.dataset.zone = state.timezone;

  el.clock.title =
    state.timezone === "utc"
      ? `Время UTC. Часовой пояс системы — ${LOCAL_TIME_ZONE} (${zoneOffsetLabel(LOCAL_TIME_ZONE, now)}). Нажмите, чтобы вернуться к времени системы.`
      : `Время системы — ${LOCAL_TIME_ZONE} (${zoneOffsetLabel(LOCAL_TIME_ZONE, now)}). Нажмите, чтобы переключиться на UTC.`;

  el.clock.setAttribute(
    "aria-label",
    `${time}, ${state.timezone === "utc" ? "UTC" : `часовой пояс системы ${zoneOffsetLabel(LOCAL_TIME_ZONE, now)}`}. Переключить часовой пояс.`,
  );
}

function toggleTimezone() {
  state.timezone = state.timezone === "utc" ? "local" : "utc";
  saveSettings();
  updateClock();
  refreshChartTime();
}

// Re-bases the timestamps already on the chart (see chartTime) without
// rebuilding it, so zoom and pan survive a time zone switch.
function refreshChartTime() {
  const chart = state.chart;
  if (!chart) return;

  const range = chart.timeScale().getVisibleLogicalRange();
  const times = chartTimes(state.candles);

  state.candleByTime = new Map(
    state.candles.map((candle, index) => [times[index], candle]),
  );

  if (state.series.candle) {
    state.series.candle.setData(
      state.candles.map((candle, index) => toCandleData(candle, times[index])),
    );
  }

  updateIndicators();

  if (range) chart.timeScale().setVisibleLogicalRange(range);
}

/* ------------------------------------------------------------------- ui */

function bindUi() {
  el.symbolBtn.addEventListener("click", openSearch);
  el.addSymbolBtn.addEventListener("click", openSearch);
  el.sidebarToggle.addEventListener("click", () => el.sidebar.classList.toggle("open"));

  el.tfGroup.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button[data-tf]") : null;
    if (button) changeInterval(button.dataset.tf);
  });

  el.themeBtn.addEventListener("click", toggleTheme);
  el.clock.addEventListener("click", toggleTimezone);
  el.clock.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleTimezone();
    }
  });
  el.indicatorsBtn.addEventListener("click", openIndicators);
  el.closeIndicators.addEventListener("click", closeIndicatorsModal);

  el.retryBtn.addEventListener("click", async () => {
    await loadHistory();
    connectStream();
  });

  el.searchInput.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    const query = el.searchInput.value;
    searchTimer = window.setTimeout(() => runSearch(query), 180);
  });

  el.searchModal.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.dataset.close === "search") closeSearch();
  });

  el.indicatorsModal.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.dataset.close === "indicators") {
      closeIndicatorsModal();
    }
  });

  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refreshQuotes();
      updateClock();
    }
  });
}

function onKeyDown(event) {
  if (event.key === "Escape") {
    closeSearch();
    closeIndicatorsModal();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openSearch();
    return;
  }

  if (el.searchModal.classList.contains("hidden")) return;

  if (event.key === "ArrowDown") {
    event.preventDefault();
    searchIndex = Math.min(searchResults.length - 1, searchIndex + 1);
    renderSearchResults();
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    searchIndex = Math.max(0, searchIndex - 1);
    renderSearchResults();
    return;
  }

  if (event.key === "Enter" && searchResults[searchIndex]) {
    event.preventDefault();
    chooseSearchResult(searchResults[searchIndex].symbol);
  }
}

function closeSidebar() {
  el.sidebar.classList.remove("open");
}

/* ------------------------------------------------------------ ui helpers */

function showLoading(visible) {
  el.chartLoading.classList.toggle("hidden", !visible);
}

function showError(message) {
  el.chartErrorText.textContent = message;
  el.chartError.classList.remove("hidden");
}

function hideError() {
  el.chartError.classList.add("hidden");
}

/* ------------------------------------------------------------------ start */

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (!Number.isFinite(period) || period <= 0) return out;

  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (!Number.isFinite(period) || period <= 0 || values.length < period) return out;

  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function bollinger(values, period = 20, mult = 2) {
  const middle = sma(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);

  for (let i = period - 1; i < values.length; i++) {
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = values[j] - middle[i];
      variance += diff * diff;
    }
    const deviation = Math.sqrt(variance / period);
    upper[i] = middle[i] + deviation * mult;
    lower[i] = middle[i] - deviation * mult;
  }

  return { upper, middle, lower };
}

export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const up = diff > 0 ? diff : 0;
    const down = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + up) / period;
    avgLoss = (avgLoss * (period - 1) + down) / period;

    out[i] = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return out;
}

export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const line = new Array(values.length).fill(null);

  for (let i = 0; i < values.length; i++) {
    if (fastEma[i] != null && slowEma[i] != null) line[i] = fastEma[i] - slowEma[i];
  }

  const signal = new Array(values.length).fill(null);
  const start = line.findIndex((value) => value != null);

  if (start >= 0) {
    const cleaned = line.slice(start).map((value) => (value == null ? 0 : value));
    const smoothed = ema(cleaned, signalPeriod);
    for (let i = 0; i < smoothed.length; i++) {
      if (smoothed[i] != null) signal[start + i] = smoothed[i];
    }
  }

  const histogram = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (line[i] != null && signal[i] != null) histogram[i] = line[i] - signal[i];
  }

  return { macd: line, signal, histogram };
}

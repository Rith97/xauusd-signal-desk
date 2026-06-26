const timeframes = document.querySelector("#timeframes");
const autoRefresh = document.querySelector("#autoRefresh");
const connectionDot = document.querySelector("#connectionDot");
const marketClock = document.querySelector("#marketClock");
const lastPrice = document.querySelector("#lastPrice");
const providerState = document.querySelector("#providerState");
const spreadState = document.querySelector("#spreadState");
const signalCard = document.querySelector("#signalCard");
const signalText = document.querySelector("#signalText");
const confidenceText = document.querySelector("#confidenceText");
const trendMetric = document.querySelector("#trendMetric");
const rsiMetric = document.querySelector("#rsiMetric");
const macdMetric = document.querySelector("#macdMetric");
const atrMetric = document.querySelector("#atrMetric");
const entryLevel = document.querySelector("#entryLevel");
const stopLevel = document.querySelector("#stopLevel");
const tp1Level = document.querySelector("#tp1Level");
const tp2Level = document.querySelector("#tp2Level");
const setupSide = document.querySelector("#setupSide");
const strategyList = document.querySelector("#strategyList");
const tvChart = document.querySelector("#tvChart");

let activeInterval = "5m";
let refreshTimer = null;
let liveSocket = null;
let lastPayload = null;
let lastCandles = [];
let lastPaint = 0;
let paintQueued = false;

let chartCanvas = null;
let chartCtx = null;
let chartReady = false;

const fmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

/* ---------- Live candlestick chart (built-in canvas) ---------- */

function initChart() {
  if (!tvChart) return;
  tvChart.innerHTML = "";
  chartCanvas = document.createElement("canvas");
  chartCanvas.className = "price-canvas";
  tvChart.append(chartCanvas);
  chartCtx = chartCanvas.getContext("2d");
  chartReady = true;
}

function sizeCanvas() {
  const rect = tvChart.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(320, Math.round(rect.width * dpr));
  const h = Math.max(320, Math.round(rect.height * dpr));
  if (chartCanvas.width !== w) chartCanvas.width = w;
  if (chartCanvas.height !== h) chartCanvas.height = h;
}

// Full redraw of the visible window: candles, EMA 9/21, and the trade-level
// lines drawn directly across the candles. Cheap (~120 candles) and throttled.
function renderChart(analysis) {
  if (!chartReady || lastCandles.length < 2) return;
  sizeCanvas();
  const ctx = chartCtx;
  const dpr = window.devicePixelRatio || 1;
  const W = chartCanvas.width;
  const H = chartCanvas.height;
  const pad = { top: 16 * dpr, right: 78 * dpr, bottom: 22 * dpr, left: 10 * dpr };

  const visible = lastCandles.slice(-140);
  const n = visible.length;
  const startIdx = lastCandles.length - n;
  const closes = lastCandles.map((candle) => candle.close);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);

  const levels = [
    { price: analysis?.tp2, color: "#27d17c", label: "TP2" },
    { price: analysis?.tp1, color: "#1fbf75", label: "TP1" },
    { price: analysis?.entry, color: "#d8a83f", label: "Entry" },
    { price: analysis?.stop, color: "#e25252", label: "SL" }
  ];

  let max = -Infinity;
  let min = Infinity;
  for (const candle of visible) {
    if (candle.high > max) max = candle.high;
    if (candle.low < min) min = candle.low;
  }
  for (const level of levels) {
    if (Number.isFinite(level.price)) {
      if (level.price > max) max = level.price;
      if (level.price < min) min = level.price;
    }
  }
  const pnear = (max - min) * 0.06 || 1;
  max += pnear;
  min -= pnear;
  const span = max - min || 1;

  const plotL = pad.left;
  const plotR = W - pad.right;
  const plotT = pad.top;
  const plotB = H - pad.bottom;
  const plotW = plotR - plotL;
  const plotH = plotB - plotT;
  const step = plotW / Math.max(n, 1);
  const candleW = Math.max(2 * dpr, step * 0.62);
  const xFor = (i) => plotL + step * (i + 0.5);
  const yFor = (price) => plotT + ((max - price) / span) * plotH;

  ctx.fillStyle = "#11161a";
  ctx.fillRect(0, 0, W, H);

  // Grid + right-edge price scale.
  ctx.strokeStyle = "#1b2228";
  ctx.lineWidth = 1;
  ctx.font = `${11 * dpr}px Inter, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  for (let i = 0; i <= 4; i += 1) {
    const y = plotT + (plotH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(plotL, y);
    ctx.lineTo(plotR, y);
    ctx.stroke();
    ctx.fillStyle = "#8b9794";
    ctx.fillText(fmt.format(max - (span / 4) * i), W - 6 * dpr, y);
  }

  // EMA overlays.
  const drawEma = (values, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i += 1) {
      const value = values[startIdx + i];
      if (!Number.isFinite(value)) continue;
      const x = xFor(i);
      const y = yFor(value);
      if (started) ctx.lineTo(x, y);
      else { ctx.moveTo(x, y); started = true; }
    }
    ctx.stroke();
  };
  drawEma(e9, "#4aa3ff");
  drawEma(e21, "#b07cf0");

  // Candles.
  for (let i = 0; i < n; i += 1) {
    const candle = visible[i];
    const x = xFor(i);
    const bull = candle.close >= candle.open;
    const color = bull ? "#1fbf75" : "#e25252";
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(1, dpr);
    ctx.beginPath();
    ctx.moveTo(x, yFor(candle.high));
    ctx.lineTo(x, yFor(candle.low));
    ctx.stroke();
    const openY = yFor(candle.open);
    const closeY = yFor(candle.close);
    ctx.fillRect(x - candleW / 2, Math.min(openY, closeY), candleW, Math.max(1.5 * dpr, Math.abs(closeY - openY)));
  }

  // Trade-level lines drawn across the candles, each with a readable price tag:
  // a solid dark plate (so the number stays legible over candles) + colored text.
  ctx.font = `${12 * dpr}px Inter, sans-serif`;
  for (const level of levels) {
    if (!Number.isFinite(level.price)) continue;
    const y = yFor(level.price);
    ctx.strokeStyle = level.color;
    ctx.lineWidth = 1.5 * dpr;
    ctx.setLineDash([6 * dpr, 5 * dpr]);
    ctx.beginPath();
    ctx.moveTo(plotL, y);
    ctx.lineTo(plotR, y);
    ctx.stroke();
    ctx.setLineDash([]);

    const text = `${level.label} ${fmt.format(level.price)}`;
    const padX = 7 * dpr;
    const tagH = 18 * dpr;
    const tagW = ctx.measureText(text).width + padX * 2 + 3 * dpr;
    const tagX = plotR - tagW;
    const tagY = y - tagH / 2;
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = "#0b0e11";
    ctx.fillRect(tagX, tagY, tagW, tagH);
    ctx.globalAlpha = 1;
    ctx.fillStyle = level.color;
    ctx.fillRect(tagX, tagY, 3 * dpr, tagH);
    ctx.textAlign = "left";
    ctx.fillText(text, tagX + 3 * dpr + padX, y);
  }
}

function showChartError(error) {
  if (tvChart) tvChart.innerHTML = `<p class="tv-loading">Chart unavailable (${error.message}). Signals still running.</p>`;
}

/* ---------- Indicators ---------- */

function sma(values, period) {
  return values.map((_, index) => {
    if (index + 1 < period) return null;
    const slice = values.slice(index + 1 - period, index + 1);
    return slice.reduce((sum, value) => sum + value, 0) / period;
  });
}

function ema(values, period) {
  const multiplier = 2 / (period + 1);
  const output = [];
  let previous = values[0];
  values.forEach((value, index) => {
    if (index === 0) {
      output.push(value);
      return;
    }
    previous = value * multiplier + previous * (1 - multiplier);
    output.push(previous);
  });
  return output;
}

function rsi(values, period = 14) {
  const output = Array(values.length).fill(null);
  let gains = 0;
  let losses = 0;

  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  output[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    output[index] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return output;
}

function atr(candles, period = 14) {
  const tr = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
  });
  return sma(tr, period);
}

function macd(values) {
  const ema12 = ema(values, 12);
  const ema26 = ema(values, 26);
  const line = values.map((_, index) => ema12[index] - ema26[index]);
  const signal = ema(line, 9);
  return { line, signal, histogram: line.map((value, index) => value - signal[index]) };
}

function candlePattern(candles) {
  const current = candles.at(-1);
  const previous = candles.at(-2);
  if (!current || !previous) return { name: "None", score: 0 };

  const body = Math.abs(current.close - current.open);
  const range = Math.max(current.high - current.low, 0.01);
  const upperWick = current.high - Math.max(current.open, current.close);
  const lowerWick = Math.min(current.open, current.close) - current.low;
  const bullishEngulfing = current.close > current.open && previous.close < previous.open && current.close > previous.open && current.open < previous.close;
  const bearishEngulfing = current.close < current.open && previous.close > previous.open && current.open > previous.close && current.close < previous.open;

  if (bullishEngulfing) return { name: "Bullish engulfing", score: 18 };
  if (bearishEngulfing) return { name: "Bearish engulfing", score: -18 };
  if (lowerWick > body * 2.2 && upperWick < body * 1.2) return { name: "Hammer / demand rejection", score: 12 };
  if (upperWick > body * 2.2 && lowerWick < body * 1.2) return { name: "Shooting star / supply rejection", score: -12 };
  if (body / range < 0.12) return { name: "Doji indecision", score: 0 };
  return { name: current.close >= current.open ? "Bullish candle" : "Bearish candle", score: current.close >= current.open ? 4 : -4 };
}

function supportResistance(candles) {
  const window = candles.slice(-80);
  return {
    support: Math.min(...window.map((candle) => candle.low)),
    resistance: Math.max(...window.map((candle) => candle.high))
  };
}

function analyze(candles) {
  const closes = candles.map((candle) => candle.close);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const rsiValues = rsi(closes);
  const macdValues = macd(closes);
  const atrValues = atr(candles);
  const pattern = candlePattern(candles);
  const levels = supportResistance(candles);
  const latest = candles.at(-1);
  const i = candles.length - 1;

  let score = 0;
  const checks = [];
  const trendBull = ema21[i] > ema50[i];
  const shortBull = ema9[i] > ema21[i];
  const rsiLatest = rsiValues[i];
  const macdHist = macdValues.histogram[i];
  const atrLatest = atrValues[i] || latest.close * 0.0015;

  score += trendBull ? 18 : -18;
  checks.push(["EMA trend", trendBull ? "Bullish" : "Bearish"]);
  score += shortBull ? 16 : -16;
  checks.push(["EMA momentum", shortBull ? "9 EMA above 21 EMA" : "9 EMA below 21 EMA"]);

  if (rsiLatest > 58 && rsiLatest < 72) score += 14;
  else if (rsiLatest < 42 && rsiLatest > 28) score -= 14;
  else if (rsiLatest >= 72) score -= 8;
  else if (rsiLatest <= 28) score += 8;
  checks.push(["RSI zone", rsiLatest ? rsiLatest.toFixed(1) : "--"]);

  score += macdHist > 0 ? 14 : -14;
  checks.push(["MACD histogram", macdHist > 0 ? "Positive" : "Negative"]);

  score += pattern.score;
  checks.push(["Candlestick", pattern.name]);

  const nearSupport = latest.close - levels.support < atrLatest * 1.5;
  const nearResistance = levels.resistance - latest.close < atrLatest * 1.5;
  if (nearSupport) score += 8;
  if (nearResistance) score -= 8;
  checks.push(["Key level", nearSupport ? "Near support" : nearResistance ? "Near resistance" : "Mid-range"]);

  const direction = score >= 35 ? "BUY" : score <= -35 ? "SELL" : "HOLD";
  const confidence = Math.min(96, Math.max(35, Math.round(Math.abs(score) * 1.15)));

  // Long unless the signal is a SELL (or a bearish-leaning HOLD). Risk = 1.4 ATR;
  // targets are projected at 1R (TP1) and 2R (TP2) from entry.
  const bias = direction === "SELL" || (direction === "HOLD" && score < 0) ? -1 : 1;
  const risk = atrLatest * 1.4;
  const entry = latest.close;
  const stop = entry - bias * risk;
  const tp1 = entry + bias * risk * 1;
  const tp2 = entry + bias * risk * 2;

  return {
    direction,
    confidence,
    score,
    checks,
    latest,
    trend: trendBull ? "Bullish" : "Bearish",
    rsi: rsiLatest,
    macd: macdHist,
    atr: atrLatest,
    side: bias === 1 ? "Long" : "Short",
    entry,
    stop,
    tp1,
    tp2
  };
}

/* ---------- Signal panel rendering ---------- */

function paintSignal() {
  paintQueued = false;
  lastPaint = Date.now();

  const payload = lastPayload;
  const candles = lastCandles;
  if (!payload || candles.length < 60) return;

  const analysis = analyze(candles);
  renderChart(analysis);

  lastPrice.textContent = fmt.format(analysis.latest.close);
  providerState.textContent = `Feed: ${payload.provider}`;
  spreadState.textContent = `${payload.symbol} ${payload.interval}`;
  if (payload.marketTime) {
    const ageSeconds = Math.max(0, Math.round((Date.now() - payload.marketTime) / 1000));
    marketClock.textContent = `Candle ${new Date(payload.marketTime).toLocaleTimeString()} · ${ageSeconds}s old`;
  }
  connectionDot.className = liveSocket ? "dot live" : "dot";

  signalCard.className = `signal-card ${analysis.direction.toLowerCase()}`;
  signalText.textContent = analysis.direction;
  confidenceText.textContent = `${analysis.confidence}% confidence · score ${analysis.score}`;
  trendMetric.textContent = analysis.trend;
  rsiMetric.textContent = analysis.rsi ? analysis.rsi.toFixed(1) : "--";
  macdMetric.textContent = analysis.macd ? analysis.macd.toFixed(2) : "--";
  atrMetric.textContent = fmt.format(analysis.atr);
  entryLevel.textContent = fmt.format(analysis.entry);
  stopLevel.textContent = fmt.format(analysis.stop);
  tp1Level.textContent = fmt.format(analysis.tp1);
  tp2Level.textContent = fmt.format(analysis.tp2);
  setupSide.textContent = analysis.side;
  setupSide.className = `side-tag ${analysis.side.toLowerCase()}`;

  strategyList.innerHTML = "";
  for (const [name, value] of analysis.checks) {
    const item = document.createElement("li");
    item.innerHTML = `<span>${name}</span><strong>${value}</strong>`;
    strategyList.append(item);
  }
}

// Coalesce rapid live ticks into at most ~4 repaints/second so the UI stays smooth.
function requestPaint(force = false) {
  if (force) {
    paintSignal();
    return;
  }
  if (paintQueued) return;
  const elapsed = Date.now() - lastPaint;
  const wait = Math.max(0, 250 - elapsed);
  paintQueued = true;
  setTimeout(() => requestAnimationFrame(paintSignal), wait);
}

function applyPayload(payload) {
  const candles = payload.candles || [];
  if (candles.length < 60) throw new Error("Not enough candles returned");
  lastPayload = payload;
  lastCandles = candles;
  requestPaint(true);
}

function updateLiveCandle(candle) {
  if (!lastPayload || !lastCandles.length) return;
  const last = lastCandles.at(-1);
  if (last && last.time === candle.time) {
    lastCandles[lastCandles.length - 1] = candle;
  } else if (!last || candle.time > last.time) {
    lastCandles.push(candle);
    if (lastCandles.length > 1500) lastCandles.shift();
  } else {
    return;
  }
  lastPayload.marketTime = candle.time;
  lastPayload.fetchedAt = Date.now();
  requestPaint();
}

/* ---------- Live feed (Binance WebSocket + REST fallback) ---------- */

function closeLiveSocket() {
  if (!liveSocket) return;
  liveSocket.onclose = null;
  liveSocket.close();
  liveSocket = null;
}

function connectLiveStream(payload) {
  closeLiveSocket();
  if (payload.dataProvider !== "binance" || !payload.wsStream) return;

  liveSocket = new WebSocket(payload.wsStream);
  liveSocket.onopen = () => {
    connectionDot.className = "dot live";
  };
  liveSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const kline = data.k;
      if (!kline) return;
      updateLiveCandle({
        time: Number(kline.t),
        open: Number(kline.o),
        high: Number(kline.h),
        low: Number(kline.l),
        close: Number(kline.c),
        volume: Number(kline.v),
        closeTime: Number(kline.T)
      });
    } catch (error) {
      showError(error);
    }
  };
  liveSocket.onerror = () => {
    connectionDot.className = "dot error";
  };
  liveSocket.onclose = () => {
    liveSocket = null;
    if (autoRefresh.checked) {
      setTimeout(() => loadSignals().catch(showError), 3000);
    }
  };
}

async function loadSignals() {
  if (!lastPayload) marketClock.textContent = "Fetching market data";
  const response = await fetch(`/api/candles?interval=${encodeURIComponent(activeInterval)}`, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.detail || payload.error || "Market data request failed");
  applyPayload(payload);
  if (autoRefresh.checked) connectLiveStream(payload);
}

function scheduleRefresh() {
  clearInterval(refreshTimer);
  if (!autoRefresh.checked) return;
  const intervalMs = activeInterval === "1m" ? 15000 : 30000;
  refreshTimer = setInterval(() => loadSignals().catch(showError), intervalMs);
}

function showError(error) {
  connectionDot.className = "dot error";
  marketClock.textContent = error.message;
}

/* ---------- Controls ---------- */

timeframes.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-interval]");
  if (!button) return;
  activeInterval = button.dataset.interval;
  for (const item of timeframes.querySelectorAll("button")) item.classList.toggle("active", item === button);
  closeLiveSocket();
  loadSignals().catch(showError);
  scheduleRefresh();
});

autoRefresh.addEventListener("change", () => {
  scheduleRefresh();
  if (autoRefresh.checked) loadSignals().catch(showError);
  else closeLiveSocket();
});

let resizeRaf = null;
window.addEventListener("resize", () => {
  if (!chartReady || lastCandles.length < 60) return;
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => requestPaint(true));
});

try {
  initChart();
} catch (error) {
  showChartError(error);
}
loadSignals().catch(showError);
scheduleRefresh();

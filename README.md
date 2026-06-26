# XAUUSD Signal Desk

A small Railway-ready web app for XAUUSD candlestick analysis and multi-timeframe technical signals.

## Features

- Live XAUUSD candlestick chart embedded from **TradingView** (`OANDA:XAUUSD`) with 1m, 5m, 15m, 30m, 1h, 4h, and 1D timeframes, EMA and RSI studies built in.
- Strategy engine using EMA trend, EMA momentum, RSI, MACD histogram, ATR, support/resistance, and candlestick patterns.
- BUY, SELL, or HOLD signal with confidence, entry, stop, and take-profit levels.
- Live signal updates over a Binance WebSocket kline stream, with throttled (≈4/s) repaints so the UI stays smooth.
- No package dependencies; runs on Node.js 20+.

## Data Sources

There are two independent feeds:

- **Chart** — the live price chart is the TradingView Advanced Chart widget loaded directly in the browser, so it streams real spot gold (`OANDA:XAUUSD`) with no server-side data plumbing. Change the symbol in `public/app.js` (`TV_SYMBOL`).
- **Signals** — the BUY/SELL/HOLD engine is computed from the server's `/api/candles` feed. The default proxy uses Binance `PAXGUSDT` (a gold-backed token that tracks spot gold closely) for REST candles plus a Binance WebSocket kline stream for live recomputation, because Binance does not list spot `XAUUSD` directly.

Yahoo Finance `GC=F` is still supported as a fallback signal feed by setting `DATA_PROVIDER=yahoo`. For execution-grade low-latency spot XAUUSD signals, connect a paid real-time metals/forex data provider or your broker feed.

Optional environment variables:

- `DATA_PROVIDER`: `binance` or `yahoo`, default `binance`.
- `BINANCE_SYMBOL`: Binance kline ticker, default `PAXGUSDT`.
- `YAHOO_SYMBOL`: Yahoo chart ticker, default `GC=F`.
- `DISPLAY_SYMBOL`: UI label, default `XAUUSD`.

## Run Locally

```bash
npm start
```

Open `http://localhost:3000`.

## Deploy to Railway

1. Push this folder to a GitHub repository.
2. Create a new Railway project from that repository.
3. Railway will use `railway.json` and run `npm start`.

If you use Railway CLI:

```bash
railway login
railway init
railway up
```

## Deploy to Render

This app includes `render.yaml` for Render Blueprint deploys.

1. Push this folder to a GitHub repository.
2. In Render, choose **New** -> **Blueprint**.
3. Connect the repository.
4. Render will read `render.yaml`, install with `npm install`, and start with `npm start`.

Manual Render web service settings:

- Runtime: `Node`
- Build command: `npm install`
- Start command: `npm start`
- Environment variables:
  - `NODE_VERSION=20`
  - `DATA_PROVIDER=binance`
  - `DISPLAY_SYMBOL=XAUUSD`
  - `BINANCE_SYMBOL=PAXGUSDT`
  - `YAHOO_SYMBOL=GC=F`

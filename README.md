# XAUUSD Signal Desk

A small Railway-ready web app for XAUUSD candlestick analysis and multi-timeframe technical signals.

## Features

- XAUUSD candlestick chart with 1m, 5m, 15m, 30m, 1h, 4h, and 1D timeframes.
- Strategy engine using EMA trend, EMA momentum, RSI, MACD histogram, ATR, support/resistance, and candlestick patterns.
- BUY, SELL, or HOLD signal with confidence, entry, stop, and take-profit levels.
- Auto-refresh market data and visible candle timestamp/latency.
- No package dependencies; runs on Node.js 20+.

## Data Source

The default server proxy uses Yahoo Finance symbol `GC=F` because Yahoo's public chart API does not reliably expose spot `XAUUSD`. This is useful for gold analysis and prototyping, but it may be delayed and it is futures-based. For execution-grade low-latency spot XAUUSD signals, connect a paid real-time metals/forex data provider or your broker feed.

Optional environment variables:

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
  - `DISPLAY_SYMBOL=XAUUSD`
  - `YAHOO_SYMBOL=GC=F`

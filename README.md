# OpenTrading

Крипто-терминал в стиле TradingView: свечные графики, индикаторы, поиск и вотчлист.
Работает на Cloudflare Workers, собирается без сборщика — только чистый ES-модульный JS.

## Возможности

- **График** — [lightweight-charts](https://github.com/tradingview/lightweight-charts) 5.x (вендорен локально, Apache-2.0), свечи + объём, 7 таймфреймов: `1m`, `5m`, `15m`, `1h`, `4h`, `1d`, `1w`.
- **Индикаторы** — SMA 20, SMA 50, EMA 50, Bollinger Bands (20, 2), RSI 14 (с уровнями 30/70), MACD (12, 26, 9). Каждая осцилляторная панель — отдельная панель графика.
- **Realtime** — прямой WebSocket к Binance (`wss://stream.binance.com`), авто-переподключение; при блокировке WS — polling через Worker каждые 5 секунд.
- **Поиск символов** — по всем спотовым парам USDT с Binance (`Ctrl+K` / `⌘K`), сортировка популярных пар вперёд.
- **Вотчлист** — цены и изменение за 24 ч, добавление/удаление, сохранение в `localStorage`; при подключённой D1 — на сервере.
- **Интерфейс** — тёмная и светлая темы, настройки (символ, таймфрейм, тема, набор индикаторов) переживают перезагрузку.
- **Отказоустойчивость** — если Binance недоступен (регион, лимиты, сбой), бэкенд отдаёт детерминированные синтетические данные и помечает их бейджем `SYNTHETIC`.

## Структура

```
src/
  index.js       роутинг /api/*, отдача статики, SPA-fallback
  http.js        JSON-ответы, cookie
  market.js      Binance REST, Cache API, синтетический fallback
  symbols.js     exchangeInfo, список пар, поиск
  watchlist.js   вотчлист в D1 (cookie-сессия)
public/
  index.html     разметка
  styles.css     темы и layout
  app.js         вся клиентская логика
  lib/indicators.js  SMA/EMA/Bollinger/RSI/MACD
  vendor/lightweight-charts.js  UMD-сборка 5.2.1
  favicon.svg
schema.sql       таблица watchlist для D1
wrangler.jsonc   конфиг Worker + Assets (+ закомментированный блок D1)
```

## API

| Метод | Путь | Описание |
| --- | --- | --- |
| `GET` | `/api/health` | статус, наличие D1, время |
| `GET` | `/api/symbols?q=btc&limit=40` | поиск спотовых пар USDT |
| `GET` | `/api/history?symbol=BTCUSDT&interval=1m&limit=600` | свечи (limit 20…1000) |
| `GET` | `/api/ticker?symbol=BTCUSDT` | цена, изменение 24 ч, high/low, объём |
| `GET` | `/api/tickers?symbols=BTCUSDT,ETHUSDT` | то же пачкой (до 50 пар) |
| `GET` | `/api/watchlist` | список символов (`storage: d1` или `local`) |
| `POST` | `/api/watchlist` | `{"symbol":"SOLUSDT"}` |
| `DELETE` | `/api/watchlist/:symbol` | удалить символ |

Ответы истории и тикеров содержат `source`: `binance`, `synthetic` или `mixed`.

## Локальная разработка

```bash
npm install
npm run dev          # http://localhost:8787
```

Единственная dev-зависимость — `wrangler`. Сборки нет: `npm run build` — no-op.

## Деплой на Cloudflare

### Workers Builds (GitHub)

Проект уже рассчитан на подключённый Git-репозиторий:

- **Build command:** `npm run build`
- **Deploy command:** `npx wrangler deploy`
- **Root directory:** `/`

Каждый пуш в `main` запускает сборку и деплой. Переменные окружения не нужны —
всё работает на бесплатном плане (Workers + Assets).

### Вручную

```bash
npx wrangler login
npm run deploy
```

## Опционально: D1 для вотчлиста

Без D1 вотчлист хранится в браузере (`localStorage`), и API отвечает `storage: "local"`.
Чтобы синхронизировать его между устройствами:

```bash
npx wrangler d1 create opentrading
```

1. Скопируйте `database_id` из вывода в `wrangler.jsonc` и раскомментируйте блок `d1_databases`.
2. Примените схему:

```bash
npx wrangler d1 execute opentrading --remote --file=./schema.sql
```

3. Задеплойте снова. Таблица также создаётся автоматически при первом запросе.

Сессия определяется cookie `ot_sid` (HttpOnly, `SameSite=Lax`, год жизни).

## Источники данных и ограничения

- Данные — публичный REST API Binance (`api.binance.com`), только спотовые пары к `USDT`.
- Из некоторых регионов Binance недоступен с edge-серверов Cloudflare — тогда включается синтетический fallback. Это **не реальные котировки**, бейдж источника в шапке показывает `SYNTHETIC`.
- WebSocket открывается напрямую из браузера, поэтому зависит от сети пользователя (в некоторых сетях нужен VPN). При неудаче приложение автоматически переходит на polling.
- Кэширование: Cache API — история 5–60 с (зависит от таймфрейма), тикеры 5–10 с, список пар 1 ч.
- Ограничения: до 50 символов в вотчлисте, до 1000 свечей за запрос (по умолчанию 600).
- Проект не даёт финансовых рекомендаций и не является торговым терминалом с исполнением ордеров.

## Лицензия

MIT — см. [LICENSE](LICENSE). lightweight-charts распространяется по Apache-2.0.

import { json, getCookie } from "./http.js";
import { parseSymbol } from "./market.js";

const COOKIE = "ot_sid";
const MAX_ITEMS = 50;

let schemaReady = false;

async function ensureSchema(db) {
  if (schemaReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS watchlist (
        sid TEXT NOT NULL,
        symbol TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (sid, symbol)
      )`,
    )
    .run();
  schemaReady = true;
}

function cookieHeader(sid) {
  return `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
}

export async function handleWatchlist(request, env, url) {
  const path = url.pathname;
  if (!path.startsWith("/api/watchlist")) return null;

  const db = env.DB;

  if (!db) {
    // No D1 binding: the browser keeps the watchlist in localStorage.
    return request.method === "GET"
      ? json({ storage: "local", symbols: [] })
      : json({ storage: "local", ok: true });
  }

  await ensureSchema(db);

  let sid = getCookie(request, COOKIE);
  const extra = {};

  if (!sid || sid.length < 8) {
    sid = crypto.randomUUID();
    extra["set-cookie"] = cookieHeader(sid);
  }

  if (path === "/api/watchlist" && request.method === "GET") {
    const { results } = await db
      .prepare("SELECT symbol FROM watchlist WHERE sid = ? ORDER BY created_at ASC")
      .bind(sid)
      .all();

    return json(
      { storage: "d1", symbols: (results || []).map((row) => row.symbol) },
      200,
      extra,
    );
  }

  if (path === "/api/watchlist" && request.method === "POST") {
    let body;

    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_body" }, 400);
    }

    const symbol = parseSymbol(body && body.symbol);
    if (!symbol) return json({ error: "invalid_symbol" }, 400);

    const count = await db
      .prepare("SELECT COUNT(*) AS total FROM watchlist WHERE sid = ?")
      .bind(sid)
      .first();

    if (count && Number(count.total) >= MAX_ITEMS) {
      return json({ error: "watchlist_full", limit: MAX_ITEMS }, 409);
    }

    await db
      .prepare(
        "INSERT OR IGNORE INTO watchlist (sid, symbol, created_at) VALUES (?, ?, ?)",
      )
      .bind(sid, symbol, Date.now())
      .run();

    return json({ storage: "d1", ok: true, symbol }, 200, extra);
  }

  if (path.startsWith("/api/watchlist/") && request.method === "DELETE") {
    const raw = decodeURIComponent(path.slice("/api/watchlist/".length));
    const symbol = parseSymbol(raw);
    if (!symbol) return json({ error: "invalid_symbol" }, 400);

    await db
      .prepare("DELETE FROM watchlist WHERE sid = ? AND symbol = ?")
      .bind(sid, symbol)
      .run();

    return json({ storage: "d1", ok: true, symbol }, 200, extra);
  }

  return json({ error: "method_not_allowed" }, 405);
}

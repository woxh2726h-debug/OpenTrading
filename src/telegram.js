import { json, getCookie } from "./http.js";

const COOKIE = "ot_tg";
const COOKIE_MAX_AGE = 31536000;
const TG_API = "https://api.telegram.org";

let schemaReady = false;
let secretCache = null;

async function ensureSchema(db) {
  if (schemaReady) return;

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS tg_bots (
        id TEXT PRIMARY KEY,
        bot_id TEXT,
        bot_username TEXT,
        token_enc TEXT NOT NULL,
        token_hmac TEXT NOT NULL UNIQUE,
        webhook_secret TEXT NOT NULL,
        start_code TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        chat_id TEXT,
        created_at INTEGER NOT NULL,
        linked_at INTEGER
      )`,
    )
    .run();

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS app_secrets (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    )
    .run();

  schemaReady = true;
}

/* ------------------------------------------------------------------ crypto */

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function fromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomHex(bytes) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

// The key lives in the Worker secret when it is configured, otherwise it is
// generated once and kept next to the data in D1.
async function secretText(env) {
  if (env.TG_SECRET) return String(env.TG_SECRET);
  if (secretCache) return secretCache;

  const row = await env.DB.prepare("SELECT value FROM app_secrets WHERE name = 'telegram'").first();
  if (row && row.value) {
    secretCache = row.value;
    return secretCache;
  }

  const value = randomHex(32);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO app_secrets (name, value, created_at) VALUES ('telegram', ?, ?)",
  )
    .bind(value, Date.now())
    .run();

  const stored = await env.DB.prepare("SELECT value FROM app_secrets WHERE name = 'telegram'").first();
  secretCache = (stored && stored.value) || value;
  return secretCache;
}

async function aesKey(env) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(await secretText(env)),
  );
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptToken(env, token) {
  const key = await aesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(token),
  );
  const output = new Uint8Array(12 + data.byteLength);
  output.set(iv, 0);
  output.set(new Uint8Array(data), 12);
  return toBase64(output);
}

async function decryptToken(env, payload) {
  const bytes = fromBase64(payload);
  const key = await aesKey(env);
  const data = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12) },
    key,
    bytes.slice(12),
  );
  return new TextDecoder().decode(data);
}

async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toHex(digest);
}

async function signValue(env, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(await secretText(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return toHex(signature).slice(0, 32);
}

/* ----------------------------------------------------------------- session */

async function readSession(request, env) {
  const raw = getCookie(request, COOKIE);
  if (!raw) return null;

  const [id, signature] = raw.split(".");
  if (!id || !signature) return null;
  if ((await signValue(env, id)) !== signature) return null;

  return env.DB.prepare("SELECT * FROM tg_bots WHERE id = ? AND status = 'linked'")
    .bind(id)
    .first();
}

function sessionCookie(id, signature) {
  return `${COOKIE}=${id}.${signature}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${COOKIE_MAX_AGE}`;
}

function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
}

/* --------------------------------------------------------------- telegram */

async function telegram(token, method, payload) {
  const response = await fetch(`${TG_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(8000),
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  return { ok: response.ok && Boolean(data && data.ok), data };
}

function maskChat(chatId) {
  const text = String(chatId || "");
  if (text.length <= 4) return text;
  return `${text.slice(0, 3)}…${text.slice(-2)}`;
}

async function ensureWebhook(env, row, origin) {
  const token = await decryptToken(env, row.token_enc);
  const result = await telegram(token, "setWebhook", {
    url: `${origin}/api/telegram/hook/${row.id}`,
    secret_token: row.webhook_secret,
    allowed_updates: ["message", "callback_query"],
  });
  return result.ok;
}

/* ------------------------------------------------------------------ routes */

async function handleCheck(request, env, url) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_body" }, 400);
  }

  const token = String((body && body.token) || "").trim();
  if (!token) return json({ error: "token_required" }, 400);

  // The token is the login: we only look it up, the real proof is the button
  // press inside Telegram.
  const hmac = await hashToken(token);
  const existing = await env.DB.prepare("SELECT * FROM tg_bots WHERE token_hmac = ?")
    .bind(hmac)
    .first();

  if (existing && existing.status === "linked") {
    const signature = await signValue(env, existing.id);
    return json(
      {
        linked: true,
        botUsername: existing.bot_username || "",
        chatId: maskChat(existing.chat_id),
      },
      200,
      { "set-cookie": sessionCookie(existing.id, signature) },
    );
  }

  let row = existing;
  let tokenForApi = token;

  if (!row) {
    const me = await telegram(token, "getMe", {});
    if (!me.ok) {
      return json(
        { error: "invalid_token", description: (me.data && me.data.description) || "getMe failed" },
        400,
      );
    }

    row = {
      id: crypto.randomUUID(),
      bot_id: String(me.data.result.id),
      bot_username: me.data.result.username || "",
      token_enc: await encryptToken(env, token),
      token_hmac: hmac,
      webhook_secret: randomHex(24),
      start_code: randomHex(12),
      status: "pending",
      created_at: Date.now(),
    };

    await env.DB.prepare(
      `INSERT INTO tg_bots
        (id, bot_id, bot_username, token_enc, token_hmac, webhook_secret, start_code, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
      .bind(
        row.id,
        row.bot_id,
        row.bot_username,
        row.token_enc,
        row.token_hmac,
        row.webhook_secret,
        row.start_code,
        row.created_at,
      )
      .run();
  } else {
    tokenForApi = await decryptToken(env, row.token_enc);
    row.start_code = randomHex(12);
    await env.DB.prepare("UPDATE tg_bots SET start_code = ? WHERE id = ?")
      .bind(row.start_code, row.id)
      .run();
  }

  await ensureWebhook(env, row, url.origin);

  return json({
    linked: false,
    botUsername: row.bot_username,
    code: row.start_code,
    deepLink: `https://t.me/${row.bot_username}?start=${row.start_code}`,
  });
}

async function handleStatus(env, url) {
  const code = String(url.searchParams.get("code") || "").trim();
  if (!code) return json({ error: "code_required" }, 400);

  const row = await env.DB.prepare("SELECT * FROM tg_bots WHERE start_code = ?")
    .bind(code)
    .first();

  if (!row || row.status !== "linked") return json({ linked: false });

  const signature = await signValue(env, row.id);
  return json(
    { linked: true, botUsername: row.bot_username || "", chatId: maskChat(row.chat_id) },
    200,
    { "set-cookie": sessionCookie(row.id, signature) },
  );
}

async function handleSession(request, env) {
  const row = await readSession(request, env);
  if (!row) return json({ linked: false });

  return json({
    linked: true,
    botUsername: row.bot_username || "",
    chatId: maskChat(row.chat_id),
    linkedAt: row.linked_at || null,
  });
}

async function handleUnlink(request, env) {
  const row = await readSession(request, env);
  if (!row) return json({ ok: true }, 200, { "set-cookie": clearCookie() });

  try {
    const token = await decryptToken(env, row.token_enc);
    await telegram(token, "sendMessage", {
      chat_id: row.chat_id,
      text: "Бот отвязан от OpenTrading. Уведомления больше не будут приходить.",
    });
    await telegram(token, "deleteWebhook", {});
  } catch {
    // The bot may already be gone; unlinking must still succeed.
  }

  await env.DB.prepare("DELETE FROM tg_bots WHERE id = ?").bind(row.id).run();

  return json({ ok: true }, 200, { "set-cookie": clearCookie() });
}

async function handleTest(request, env) {
  const row = await readSession(request, env);
  if (!row) return json({ error: "not_linked" }, 401);

  const token = await decryptToken(env, row.token_enc);
  const result = await telegram(token, "sendMessage", {
    chat_id: row.chat_id,
    text: "OpenTrading: проверка связи — всё работает ✅",
  });

  if (!result.ok) {
    return json(
      { error: "send_failed", description: (result.data && result.data.description) || "" },
      502,
    );
  }

  return json({ ok: true });
}

async function handleHook(request, env, id) {
  const row = await env.DB.prepare("SELECT * FROM tg_bots WHERE id = ?").bind(id).first();
  if (!row) return json({ ok: true });

  const header = request.headers.get("x-telegram-bot-api-secret-token") || "";
  if (header !== row.webhook_secret) return json({ error: "forbidden" }, 403);

  let update;
  try {
    update = await request.json();
  } catch {
    return json({ ok: true });
  }

  const token = await decryptToken(env, row.token_enc);
  const message = update.message;

  if (message && typeof message.text === "string") {
    const chatId = String(message.chat.id);
    const [, code] = message.text.trim().split(/\s+/);

    if (message.text.startsWith("/start") && row.start_code && code === row.start_code) {
      await telegram(token, "sendMessage", {
        chat_id: chatId,
        text: `Подключить бота @${row.bot_username} к OpenTrading?`,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Подтвердить", callback_data: `ok:${row.id}` },
              { text: "❌ Отмена", callback_data: `no:${row.id}` },
            ],
          ],
        },
      });
    } else if (message.text.startsWith("/start")) {
      await telegram(token, "sendMessage", {
        chat_id: chatId,
        text: "Откройте OpenTrading, вставьте токен бота в «Уведомления» и нажмите кнопку подключения — я пришлю подтверждение.",
      });
    }
  }

  const query = update.callback_query;

  if (query && query.message) {
    const data = String(query.data || "");
    const chatId = String(query.message.chat && query.message.chat.id);

    if (data === `ok:${row.id}`) {
      await env.DB.prepare(
        "UPDATE tg_bots SET status = 'linked', chat_id = ?, linked_at = ? WHERE id = ?",
      )
        .bind(chatId, Date.now(), row.id)
        .run();

      await telegram(token, "answerCallbackQuery", { callback_query_id: query.id, text: "Готово" });
      await telegram(token, "editMessageText", {
        chat_id: chatId,
        message_id: query.message.message_id,
        text: "✅ Бот подключён к OpenTrading. Вернитесь на сайт — настройки уже доступны.",
      });
    } else if (data === `no:${row.id}`) {
      await telegram(token, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "Отменено",
      });
      await telegram(token, "editMessageText", {
        chat_id: chatId,
        message_id: query.message.message_id,
        text: "❌ Подключение отменено.",
      });
    }
  }

  return json({ ok: true });
}

export async function handleTelegram(request, env, url) {
  const path = url.pathname;
  if (!path.startsWith("/api/telegram")) return null;

  if (!env.DB) return json({ error: "d1_required" }, 503);

  await ensureSchema(env.DB);

  const method = request.method;

  if (path === "/api/telegram/session" && method === "GET") return handleSession(request, env);
  if (path === "/api/telegram/check" && method === "POST") return handleCheck(request, env, url);
  if (path === "/api/telegram/status" && method === "GET") return handleStatus(env, url);
  if (path === "/api/telegram/unlink" && method === "POST") return handleUnlink(request, env);
  if (path === "/api/telegram/test" && method === "POST") return handleTest(request, env);

  if (path.startsWith("/api/telegram/hook/") && method === "POST") {
    return handleHook(request, env, path.slice("/api/telegram/hook/".length));
  }

  return json({ error: "not_found" }, 404);
}

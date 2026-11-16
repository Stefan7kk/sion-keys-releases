import { handleDailyVerse } from "./youversion-verse.mjs";

const route = "/api/verse-of-the-day";
const desktopOrigins = "http://tauri.localhost,https://tauri.localhost,tauri://localhost";
const dayMs = 24 * 60 * 60 * 1000;

export async function handleVerseRequest(request, env, fetcher = fetch) {
  const url = new URL(request.url);
  const headers = new Headers({ "Cache-Control": "no-store", Vary: "Origin" });
  const send = (status, error) => Response.json({ error }, { status, headers });
  if (url.pathname !== route) return send(404, "not_found");

  const origin = request.headers.get("Origin");
  if (origin) {
    const allowedOrigins = (env.YOUVERSION_ALLOWED_ORIGINS ?? desktopOrigins).split(",").map(value => value.trim());
    if (!allowedOrigins.includes(origin)) return send(403, "origin_denied");
    headers.set("Access-Control-Allow-Origin", origin);
  }

  headers.set("Allow", "GET, OPTIONS");
  if (request.method === "OPTIONS") {
    headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "GET") return send(405, "method_not_allowed");

  // Neighboring days allow today's local date in any time zone.
  const date = url.searchParams.get("date");
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ? Date.parse(date) : NaN;
  const today = Math.floor(Date.now() / dayMs) * dayMs;
  if (!Number.isFinite(day) || Math.abs(day - today) > dayMs) return send(400, "invalid_date");
  if (!env.VERSE_RATE_LIMIT) return send(503, "unavailable");

  const client = request.headers.get("CF-Connecting-IP") ?? "unknown";
  try {
    const { success } = await env.VERSE_RATE_LIMIT.limit({ key: client });
    if (!success) {
      headers.set("Retry-After", "60");
      return send(429, "rate_limited");
    }
    const result = await handleDailyVerse(request, env, fetcher);
    headers.set("Content-Type", "application/json; charset=utf-8");
    return new Response(result.body, { status: result.status, headers });
  } catch {
    return send(502, "unavailable");
  }
}

export default {
  fetch(request, env) {
    return handleVerseRequest(request, env);
  },
};

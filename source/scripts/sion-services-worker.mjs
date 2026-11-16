const json = (data, status = 200, headers = {}) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
const route = /^\/api\/library\/(f-[0-9a-f]{64}|[\w-]{11})\/(analysis|lyrics)\/([a-z0-9-]{2,40})$/;
const maxBytes = 256 * 1024;
const origins = new Set(["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost",
  "http://localhost:1420", "http://127.0.0.1:1420"]);
const scalar = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;

function updateManifest(raw) {
  if (!raw) return new Response(null, { status: 204, headers: { "Cache-Control": "public, max-age=60" } });
  try {
    const manifest = JSON.parse(raw);
    const platforms = Object.values(manifest.platforms ?? {});
    if (!/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(manifest.version) || !platforms.length ||
        !platforms.every(({ url, signature }) => {
          const parsed = new URL(url);
          return parsed.protocol === "https:" && !parsed.username && !parsed.password && scalar(signature, 8192);
        })) throw new Error("Invalid manifest");
    return json(manifest, 200, { "Cache-Control": "public, max-age=60" });
  } catch {
    return json({ error: "invalid-release-manifest" }, 503);
  }
}

async function boundedBody(request) {
  if (!request.body || Number(request.headers.get("Content-Length")) > maxBytes) throw new RangeError();
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) { await reader.cancel(); throw new RangeError(); }
    text += decoder.decode(value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}

function analysisPayload(body, privateName) {
  const { engineVersion, source, key, chords, rawChords, waveform, meta } = body;
  const duration = source?.durationSec;
  if (!scalar(engineVersion, 40) || !scalar(source?.name, 240) ||
      !(Number.isFinite(duration) && duration > 0 && duration <= 3600) ||
      !(Number.isFinite(source.sampleRate) && source.sampleRate > 0 && source.sampleRate <= 192000) ||
      !scalar(key?.label, 64) || !scalar(key.tonic, 16) || !scalar(key.mode, 24) ||
      !Array.isArray(chords) || !Array.isArray(rawChords) || !Array.isArray(waveform) ||
      chords.length > 5000 || rawChords.length > 5000 || waveform.length > 10000 ||
      !waveform.every(Number.isFinite) || !Number.isFinite(meta?.hopLength)) return null;
  const cleanChords = values => values.map(chord => {
    const { start, end, label, display, score, scoreKind, kind } = chord ?? {};
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start ||
        end > duration + 1 || typeof label !== "string" || label.length > 40 ||
        !scalar(display, 40) || !scalar(scoreKind, 48) ||
        !["chord", "no_chord", "uncertain"].includes(kind) || !(score === null || Number.isFinite(score))) throw new TypeError();
    return { start, end, label, display, score, scoreKind, kind };
  });
  const fallback = key.alternative;
  const packedKey = { label: key.label, tonic: key.tonic, mode: key.mode,
    score: Number.isFinite(key.score) ? key.score : null, scoreKind: "profile_correlation",
    uncertain: key.uncertain === true, margin: Number.isFinite(key.margin) ? key.margin : null,
    alternative: fallback && scalar(fallback.tonic, 16) && scalar(fallback.mode, 24) && scalar(fallback.label, 64) ?
      { tonic: fallback.tonic, mode: fallback.mode, label: fallback.label,
        score: Number.isFinite(fallback.score) ? fallback.score : null, scoreKind: "profile_correlation",
        relation: scalar(fallback.relation, 24) ? fallback.relation : undefined } : null };
  const textList = (values, limit) => Array.isArray(values) ? values.filter(value => scalar(value, limit)).slice(0, 100) : [];
  const packedMeta = { elapsedSec: Number.isFinite(meta.elapsedSec) ? meta.elapsedSec : 0, hopLength: meta.hopLength,
    tempoBpm: Number.isFinite(meta.tempoBpm) ? meta.tempoBpm : undefined,
    timeSignature: scalar(meta.timeSignature, 40) ? meta.timeSignature : undefined,
    meterConfidence: ["strong", "moderate"].includes(meta.meterConfidence) ? meta.meterConfidence : undefined,
    meterPulseBpm: Number.isFinite(meta.meterPulseBpm) ? meta.meterPulseBpm : undefined,
    meterBeats: Array.isArray(meta.meterBeats) ? meta.meterBeats.slice(0, 4096)
      .filter(beat => Array.isArray(beat) && Number.isFinite(beat[0]) && typeof beat[1] === "boolean")
      .map(beat => [beat[0], beat[1]]) : undefined,
    vocabulary: textList(meta.vocabulary, 40), notes: [], scoreKinds: {} };
  return { ok: true, engineVersion, source: { name: privateName ? "Local recording" : source.name, durationSec: duration, sampleRate: source.sampleRate },
    key: packedKey, chords: cleanChords(chords), rawChords: cleanChords(rawChords), waveform, meta: packedMeta };
}

function lyricPayload(body) {
  if (!/^[0-9a-f]{64}$/.test(body.digest) ||
      !["generated", "edited", "imported"].includes(body.origin)) return null;
  const { method, checkedLines, checkedWords, totalWords } = body.proof ?? {};
  if (method !== "recording-v1" || !Number.isInteger(checkedLines) || checkedLines < 1 || checkedLines > 200 ||
      !Number.isInteger(checkedWords) || !Number.isInteger(totalWords) ||
      totalWords < 8 || totalWords > 1800 || checkedWords > totalWords || checkedWords * 10 < totalWords * 9) return null;
  return body.digest;
}

async function publishLyrics(db, recording, language, digest) {
  const result = await db.prepare(`
    WITH requested(id, locale, digest) AS (VALUES (?, ?, ?)), matches AS (
      SELECT r.* FROM lyric_references AS r, requested
      WHERE r.recording = id AND (locale = 'auto' OR r.language = locale) AND r.lyrics_digest = digest
    )
    INSERT OR IGNORE INTO contributions (video, kind, revision, digest, body, published)
    SELECT recording, 'lyrics', language, lyrics_digest, json_object('text', text, 'origin', 'reference'), 1
    FROM matches WHERE (SELECT count(*) FROM matches) = 1
  `).bind(recording, language, digest).run();
  if (result.meta.changes) return json({ state: "published" }, 201);
  const prior = await db.prepare(`
    WITH requested(id, locale, digest) AS (VALUES (?, ?, ?))
    SELECT 1 FROM lyric_references AS r JOIN contributions AS c
      ON c.video = r.recording AND c.revision = r.language AND c.digest = r.lyrics_digest
    CROSS JOIN requested
    WHERE r.recording = id AND (locale = 'auto' OR r.language = locale) AND r.lyrics_digest = requested.digest
      AND c.kind = 'lyrics' AND c.published = 1
  `).bind(recording, language, digest).first();
  return prior ? json({ state: "published" }, 200) : json({ state: "reference-required" }, 422);
}

async function compressRecord(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const packed = await new Response(stream).arrayBuffer();
  return packed.byteLength < new TextEncoder().encode(text).byteLength ? packed : text;
}

async function library(request, env, video, kind, revision) {
  if (!env.SION_LIBRARY) return json({ error: "library-unavailable" }, 503);
  if (request.method === "GET") {
    const record = await env.SION_LIBRARY.prepare(`
      WITH requested(id, type, locale) AS (VALUES (?, ?, ?)), available AS (
        SELECT c.body, c.revision, c.created_at, c.rowid AS sequence
        FROM contributions AS c, requested
        WHERE c.video = id AND c.kind = type AND c.published = 1
          AND CASE WHEN c.kind = 'lyrics' AND json_extract(c.body, '$.origin') = 'reference'
            THEN EXISTS (SELECT 1 FROM lyric_references AS r
              WHERE r.recording = c.video AND r.language = c.revision AND r.lyrics_digest = c.digest)
            ELSE 1 END
      )
      SELECT body FROM available, requested
      WHERE revision = locale OR (type = 'lyrics' AND locale = 'auto' AND
        (SELECT count(DISTINCT revision) FROM available) = 1)
      ORDER BY created_at DESC, sequence DESC LIMIT 1
    `).bind(video, kind, revision).first();
    const decoded = record && (typeof record.body === "string" ? record.body :
      new Blob([Uint8Array.from(record.body)]).stream().pipeThrough(new DecompressionStream("gzip")));
    return record ? new Response(decoded, {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60" },
    }) : new Response(null, { status: 404, headers: { "Cache-Control": "public, max-age=30" } });
  }
  if (request.method !== "POST") return json({ error: "method-not-allowed" }, 405);
  if (!env.CONTRIBUTION_LIMIT) return json({ error: "submissions-unavailable" }, 503);
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  if (!(await env.CONTRIBUTION_LIMIT.limit({ key: ip })).success) return json({ error: "rate-limited" }, 429);
  let item;
  try {
    const raw = await boundedBody(request);
    item = kind === "analysis" ? analysisPayload(raw, video.length > 11) : lyricPayload(raw);
  } catch (error) {
    return json({ error: "invalid-submission" }, error instanceof RangeError ? 413 : 400);
  }
  if (!item) return json({ error: "invalid-submission" }, 400);
  if (kind === "lyrics") return publishLyrics(env.SION_LIBRARY, video, revision, item);
  const serialized = JSON.stringify(item);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized))),
    byte => byte.toString(16).padStart(2, "0")).join("");
  const body = await compressRecord(serialized);
  const saved = await env.SION_LIBRARY.prepare(`
    INSERT OR IGNORE INTO contributions (video, kind, revision, digest, body)
    SELECT ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM contributions WHERE published = 0) < 256
  `).bind(video, kind, revision, digest, body).run();
  return saved.meta.changes > 0 ? json({ state: "pending" }, 202) : json({ state: "duplicate-or-queue-full" }, 409);
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/api/updates/latest.json" && request.method === "GET") return updateManifest(env.SION_UPDATE_MANIFEST);
    const match = route.exec(path);
    if (!match) return json({ error: "not-found" }, 404);
    const origin = request.headers.get("Origin");
    if (origin && !origins.has(origin)) return json({ error: "origin-not-allowed" }, 403);
    const headers = new Headers({ "Vary": "Origin", "X-Content-Type-Options": "nosniff" });
    if (origin) headers.set("Access-Control-Allow-Origin", origin);
    if (request.method === "OPTIONS") {
      headers.set("Access-Control-Allow-Headers", "Content-Type");
      headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      headers.set("Access-Control-Max-Age", "600");
      return new Response(null, { status: 204, headers });
    }
    let response;
    try { response = await library(request, env, ...match.slice(1)); }
    catch { response = json({ error: "library-unavailable" }, 503); }
    for (const [name, value] of response.headers) headers.set(name, value);
    return new Response(response.body, { status: response.status, headers });
  },
  async scheduled(_event, env) {
    await env.SION_LIBRARY.prepare("DELETE FROM contributions WHERE published = 0 AND created_at < unixepoch() - 604800").run();
  },
};

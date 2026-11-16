// Mount this handler at a dedicated HTTPS route. Configuration stays on the server.
const api = "https://api.youversion.com/v1";
const languages = new Set("en bg he tr es fr de pt it ru zh ja ko ar hi bn id ur vi th pl uk ro".split(" "));
const preferredEdition = { en: 59, bg: 1443 };
const cache = new Map();
let cacheKey;
let cacheFetcher;

// Optional verified editions take precedence for the reading when available.
// The image API identifies the passage and language, but omits its Bible edition.
function approvedArtwork(env, date, language) {
  if (env.YOUVERSION_VERSE_ART_APPROVED !== "1") return null;
  try {
    const entry = JSON.parse(env.YOUVERSION_VERSE_ART_EDITIONS ?? "{}")?.[`${date}:${language}`];
    if (!entry || typeof entry.languageTag !== "string"
      || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(entry.languageTag)
      || entry.languageTag.toLowerCase().split("-")[0] !== language
      || !Number.isSafeInteger(entry.version) || entry.version <= 0
      || typeof entry.passageId !== "string") return null;
    return entry;
  } catch {
    return null;
  }
}

async function resolveArtwork(get, imageId, selection, approval, report) {
  if (typeof imageId !== "string" || !imageId || imageId.length > 4096) {
    report("image-id-unavailable");
    return null;
  }
  const image = await get("/images/" + encodeURIComponent(imageId), false, "image-metadata");
  const tag = typeof image?.language_tag === "string" ? image.language_tag.replaceAll("_", "-") : "";
  const language = selection.language;
  const sameLanguage = language === "zh" ? /^zh-(?:CN|Hans(?:-CN)?)$/i.test(tag)
    : tag.toLowerCase().split("-")[0] === language;
  if (!image || image.passage_id !== selection.passageId || !sameLanguage
    || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(tag)
    || typeof image.attribution !== "string" || !image.attribution.trim() || image.attribution.length > 500
    || !Number.isSafeInteger(image.width) || image.width <= 0
    || !Number.isSafeInteger(image.height) || image.height <= 0
    || typeof image.image_url !== "string" || !URL.canParse(image.image_url)) {
    report("image-metadata-mismatch");
    return null;
  }
  const url = new URL(image.image_url);
  if (url.origin !== "https://cdn.youversion.com" || url.username || url.password
    || !url.pathname.startsWith("/images/")) {
    report("image-url-rejected");
    return null;
  }
  url.searchParams.set("size", "card");
  return {
    url: url.href, attribution: image.attribution.trim(), width: image.width, height: image.height,
    date: selection.date, passageId: selection.passageId, languageTag: tag,
    ...(approval?.languageTag.toLowerCase() === tag.toLowerCase() ? { version: approval.version } : {}),
  };
}

export async function handleDailyVerse(request, env = process.env, fetcher = fetch) {
  const key = env.YOUVERSION_APP_KEY;
  const query = new URL(request.url).searchParams;
  const language = query.get("language");
  const date = query.get("date");
  const respond = (body, status) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (request.method !== "GET") return respond({ error: "unavailable" }, 405);
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ? new Date(date) : null;
  if (!languages.has(language) || !parsed || !Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== date) {
    return respond({ error: "invalid_request" }, 400);
  }
  const report = (stage, status) => {
    if (env.YOUVERSION_DIAGNOSTICS === "1") {
      console.info("[youversion-verse]", { date, language, stage, ...(status === undefined ? {} : { status }) });
    }
  };
  if (!key) {
    report("app-key-missing");
    return respond({ error: "unavailable" }, 503);
  }
  const day = (+parsed - Date.UTC(parsed.getUTCFullYear(), 0, 1)) / 86400000 + 1;
  const artworkEnabled = env.YOUVERSION_VERSE_ART_APPROVED === "1";
  const approval = approvedArtwork(env, date, language);
  if (!artworkEnabled) report("artwork-disabled");
  if (cacheKey !== key || cacheFetcher !== fetcher) {
    cache.clear();
    cacheKey = key;
    cacheFetcher = fetcher;
  }
  const prefix = `${date}:${language}:`;
  let cachedVerse;
  let cachedApprovedVerse;
  for (const [id, entry] of cache) {
    if (entry.expires <= Date.now()) cache.delete(id);
    else if (id.startsWith(prefix)) {
      if (!cachedVerse || entry.verse.version === preferredEdition[language]) cachedVerse = entry.verse;
      if (entry.verse.version === approval?.version) cachedApprovedVerse = entry.verse;
    }
  }

  const signal = AbortSignal.timeout(6500);
  const get = async (path, localized = true, stage = "text") => {
    let response;
    try {
      response = await fetcher(api + path, {
        headers: { "X-YVP-App-Key": key, Accept: "application/json", ...(localized ? { "Accept-Language": language } : {}) },
        redirect: "manual", signal,
      });
    } catch (error) {
      report(`${stage}-${signal.aborted ? "timeout" : "network"}`);
      throw error;
    }
    if (response.status >= 300 && response.status < 400) {
      report(`${stage}-unexpected-redirect`, response.status);
      throw new Error("Unexpected YouVersion redirect");
    }
    if (!response.ok || response.status === 204) report(stage, response.status);
    if (response.status === 204 || response.status === 403 || response.status === 404) return null;
    if (!response.ok) throw new Error("YouVersion request failed");
    return response.json();
  };
  const getArtDay = () => {
    const query = new URLSearchParams({ "language_ranges[]": approval?.languageTag ?? (language === "zh" ? "zh-CN" : language) });
    return get(`/verse-of-the-days/${day}?${query}`, false, "localized-daily-art");
  };
  try {
    if (cachedVerse && !artworkEnabled) return respond(cachedVerse, 200);
    const availableArt = artworkEnabled ? await getArtDay().catch(() => {
      report("localized-daily-art-failed");
      return null;
    }) : null;
    const validDay = entry => entry?.day === day
      && /^[A-Z0-9]{3}\.\d{1,3}\.\d{1,3}(?:-\d{1,3})?$/.test(entry.passage_id ?? "");
    const artDay = validDay(availableArt) ? availableArt : null;
    const selection = artDay ?? await get("/verse-of-the-days/" + day, false, "daily-passage");
    if (!validDay(selection)) return respond({ error: "unavailable" }, 502);
    const passageId = selection.passage_id;
    const dailySelection = { date, language, passageId };
    const verifiedEdition = artDay?.image_id && approval?.passageId === passageId ? approval : null;
    const getReading = async (path, stage) => {
      try { return await get(path, true, stage); }
      catch (error) {
        if (!artDay?.image_id) throw error;
        return null;
      }
    };
    const artworkResult = artDay
      ? resolveArtwork(get, artDay.image_id, dailySelection, verifiedEdition, report).catch(() => {
          report("image-metadata-failed");
          return null;
        })
      : null;
    const withArtwork = async verse => {
      const artwork = await artworkResult;
      if (artwork) report("image-resolved");
      return respond(artwork ? { ...verse, artwork } : verse, 200);
    };
    if (verifiedEdition && cachedApprovedVerse?.passageId === passageId) return withArtwork(cachedApprovedVerse);
    if (!verifiedEdition && cachedVerse?.passageId === passageId) return withArtwork(cachedVerse);

    const params = new URLSearchParams({ "language_ranges[]": language, all_available: "false", page_size: "99" });
    const visited = new Set();
    const candidates = [];
    const preferred = verifiedEdition?.version ?? preferredEdition[language];
    const tryEdition = async bible => {
      const version = bible?.id;
      const languageTag = typeof bible?.language_tag === "string" ? bible.language_tag : "";
      if (!Number.isSafeInteger(version) || version <= 0 || languageTag.toLowerCase().split("-")[0] !== language) return null;
      const publisher = bible.publisher_name?.trim();
      const edition = bible.localized_title?.trim() || bible.title?.trim();
      const attribution = bible.copyright?.trim() || bible.promotional_content?.trim()
        || (publisher && [edition, publisher].filter(Boolean).join(" · "));
      if (!attribution) return null;
      const passage = await getReading(`/bibles/${version}/passages/${passageId}?format=text`, "scripture-passage");
      const text = passage?.content?.trim();
      const reference = passage?.reference?.trim();
      if (!text || !reference || passage.id !== passageId) return null;
      const verse = { date, language, languageTag, passageId, version, text, reference, attribution };
      if (cacheKey === key && cacheFetcher === fetcher) {
        if (cache.size >= 128) cache.delete(cache.keys().next().value);
        cache.set(prefix + version, { verse, expires: Date.now() + 3600000 });
      }
      return withArtwork(verse);
    };
    do {
      const collection = await getReading("/bibles?" + params, "bible-catalog");
      if (!collection) break;
      if (!Array.isArray(collection.data)) {
        if (artDay?.image_id) return withArtwork(dailySelection);
        return respond({ error: "unavailable" }, 502);
      }
      for (const bible of collection.data) {
        if (preferred && bible?.id !== preferred) {
          candidates.push(bible);
          continue;
        }
        const result = await tryEdition(bible);
        if (result) return result;
      }
      const token = collection.next_page_token;
      if (!token || visited.has(token)) break;
      visited.add(token);
      params.set("page_token", token);
    } while (!signal.aborted);
    if (cachedVerse?.passageId === passageId && cachedVerse.version === preferredEdition[language]) {
      return withArtwork(cachedVerse);
    }
    if (verifiedEdition && preferredEdition[language]) {
      const fallback = candidates.findIndex(bible => bible?.id === preferredEdition[language]);
      if (fallback > 0) candidates.unshift(candidates.splice(fallback, 1)[0]);
    }
    for (const bible of candidates) {
      if (signal.aborted) break;
      const result = await tryEdition(bible);
      if (result) return result;
    }
    if (cachedVerse?.passageId === passageId) return withArtwork(cachedVerse);
    // No accessible online reading. The client can use a bundled edition if it
    // contains exactly this passage, or fall back to its regular offline card.
    if (artworkEnabled) return withArtwork(dailySelection);
    return respond({ error: "unavailable" }, signal.aborted ? 502 : 404);
  } catch {
    if (cachedVerse) return respond(cachedVerse, 200);
    report("text-request-failed");
    return respond({ error: "unavailable" }, 502);
  }
}

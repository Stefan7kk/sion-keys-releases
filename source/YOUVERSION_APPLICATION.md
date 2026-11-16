# YouVersion application for Sion Keys

Register through the [YouVersion Platform Portal](https://platform.youversion.com/). Use the project owner's developer account and enter the verified project website if the form requests one.

**Application name**  
Sion Keys – Chord & Key Analyzer

**Description for the portal**

> Sion Keys is a free, open-source desktop app that helps musicians and worship teams learn songs by identifying keys and chords from audio. We would like to display YouVersion’s Verse of the Day on the empty Analyze welcome screen. The app requests the daily passage in the user’s selected language using an authorized Bible edition. It shows the passage reference and publisher attribution, and links to the verse and full chapter on Bible.com. Sharing sends a Bible.com link. We would also like permission for a user-initiated attributed copy action and short-lived server caching where the edition’s terms permit them.

The interface supports Arabic, Bengali, Bulgarian, English, French, German, Hebrew, Hindi, Indonesian, Italian, Japanese, Korean, Polish, Portuguese, Romanian, Russian, Simplified Chinese, Spanish, Thai, Turkish, Ukrainian, Urdu and Vietnamese. Request access to editions approved for this use. Confirm attribution, caching and copying terms for each edition with YouVersion before enabling it. The implementation uses the REST API and needs no user sign-in scopes.

After registration, store the App Key as `YOUVERSION_APP_KEY` in the HTTPS route host's secret store. Mount `scripts/youversion-verse.mjs` on that host, configure rate limiting and the app origins, then set `VITE_YOUVERSION_VERSE_URL` to the public route URL. Use a test deployment to verify real text, publisher attribution, copy permissions and missing-language behavior with the approved editions.

[App Key setup](https://developers.youversion.com/authentication) · [API usage and publisher licenses](https://developers.youversion.com/api-usage)

## Host the HTTPS route

Cloudflare Workers Free can host the verse backend over HTTPS. The dedicated `wrangler.verse.jsonc` bundles only the Worker entry point and the existing YouVersion handler. It applies per-client rate limits and serves `/api/verse-of-the-day`. The route allows Tauri desktop origins by default. Use `YOUVERSION_ALLOWED_ORIGINS` as a comma-separated override for a browser or Vite development address.

1. Sign in to the intended Cloudflare account and deploy from this folder with `npx wrangler deploy --config wrangler.verse.jsonc`. Choose a unique Worker name or rate-limit namespace in this account if the proposed values are already used.
2. In Workers & Pages → sion-keys-verse → Settings → Variables and Secrets, add the rotated App Key as a **Secret** named `YOUVERSION_APP_KEY`. Configure artwork approval and verified editions using the settings below.
3. Verify the deployed route from the allowed desktop origin with today's date and `language=en` and `language=bg`. Set `VITE_YOUVERSION_VERSE_URL` to the deployed Worker URL followed by `/api/verse-of-the-day`. Rebuild the desktop app once the route is verified. The client variable contains only the public HTTPS address.

[Cloudflare deployment](https://developers.cloudflare.com/workers/get-started/guide/) · [Encrypted secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

## Preferred editions

Request ESV (YouVersion version ID 59) for English and РИ ББД (ID 1443) for Bulgarian. The route picks these first when the App Key has the required access and the passage is available. Confirm the rights for live display, local Copy and server caching with each publisher. [ESV digital permission form](https://www.crossway.org/permissions/digital/) · [Bulgarian Bible Society edition terms](https://biblesociety.bg/brands.html)

## Official daily artwork

After confirming this app's artwork access in YouVersion, set `YOUVERSION_VERSE_ART_APPROVED=1` on the same HTTPS host. The route requests artwork for the selected date and locale automatically. Simplified Chinese uses `zh-CN` and accepts YouVersion's `zh_CN` metadata spelling. The Images API identifies the passage and language. The artwork carries its own YouVersion credit and the reading carries its own edition attribution, since its wording may differ from the image.

When the source edition on a particular image is independently verified, an optional `YOUVERSION_VERSE_ART_EDITIONS` entry can give that edition priority when selecting the reading. Use `YYYY-MM-DD:language` with `passageId`, `languageTag` and numeric `version`. The route checks the authorized catalog even for a verified entry.

The route resolves the opaque image reference per request, checks its passage and language, and returns its CDN URL at card size with its attribution. If live text is inaccessible, the desktop client pairs the artwork with a bundled translation only if that exact passage is present in the current language. An unavailable image or missing reading match gives the local artwork. The response is marked `no-store`. The text cache holds no artwork or opaque IDs, and the WebView follows the CDN cache headers. [YouVersion Verse Images guide](https://developers.youversion.com/guides/images)

### Diagnose the fallback

1. Build the desktop client with only the route URL in `VITE_YOUVERSION_VERSE_URL`. Inspect `data-verse-provider` on the verse card in WebView2. `unconfigured` means the client never attempted a request. `invalid-endpoint`, `endpoint-http-…`, `network-error`, `timeout`, and `response-rejected` distinguish other client failures.
2. For a test deployment, set `YOUVERSION_DIAGNOSTICS=1` on the server. The route logs the date, app locale, stage, and any HTTP status. It omits credentials, opaque image references, CDN URLs, and Scripture text. A 401 or 403 helps distinguish request rejection from a successful daily response with no image ID.
3. `image-id-unavailable` means YouVersion provided no artwork for that locale and date. `image-metadata-mismatch` means its passage, language, credit or dimensions could not be verified. If the route has a verified edition record for the selected artwork, it still tries that edition through the authorized catalog before other same-language versions.
4. Once the route logs `image-resolved`, `data-artwork-state` distinguishes `loading`, `ready`, and `failed` in WebView2. `fallback` means no eligible image reached the renderer. Inspect network status for a failed image without publishing its CDN URL. Verify both English and Bulgarian using today's real authorized responses before calling live artwork ready.

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "./Icon";
import { translate } from "../lib/i18n";
import { offlineDailyVerse } from "../lib/offlineScripture";
import { languageDirection, type Language } from "../lib/languages";

function artworkExcerpt(text: string, language: string) {
  const compact = text.trim();
  const limit = 120;
  if (compact.length <= limit) return { text: compact, shortened: false };
  const words = new Intl.Segmenter(language, { granularity: "word" });
  let end = 0;
  for (const { index, segment } of words.segment(compact)) {
    if (index + segment.length > limit) break;
    end = index + segment.length;
  }
  if (!end) {
    for (const { index, segment } of new Intl.Segmenter(language).segment(compact)) {
      if (index + segment.length > limit) break;
      end = index + segment.length;
    }
  }
  return { text: `${compact.slice(0, end).trimEnd()}…`, shortened: true };
}

type Artwork = {
  url: string; attribution: string; width: number; height: number;
  date: string; passageId: string; languageTag: string;
};
type DailySelection = {
  date: string; language: string; passageId: string; artwork?: unknown;
};
type Verse = DailySelection & {
  languageTag: string; version: number; text: string; reference: string; attribution: string;
};

function httpsUrl(value: unknown): URL | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function matchingArtwork(selection: DailySelection): Artwork | null {
  if (!selection.artwork || typeof selection.artwork !== "object") return null;
  const art = selection.artwork as Partial<Artwork>;
  if (art.date !== selection.date || art.passageId !== selection.passageId
    || typeof art.languageTag !== "string" || art.languageTag.toLowerCase().split("-")[0] !== selection.language
    || (selection.language === "zh" && !/^zh-(?:CN|Hans(?:-CN)?)$/i.test(art.languageTag))
    || typeof art.attribution !== "string" || !art.attribution.trim() || art.attribution.length > 500
    || typeof art.width !== "number" || !Number.isSafeInteger(art.width) || art.width <= 0
    || typeof art.height !== "number" || !Number.isSafeInteger(art.height) || art.height <= 0) return null;
  const url = httpsUrl(art.url);
  return url?.origin === "https://cdn.youversion.com" && url.pathname.startsWith("/images/") ? art as Artwork : null;
}

function VerseArtwork({ artwork, direction, reference, children }: { artwork: Artwork | null; direction: string; reference: string; children: ReactNode }) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const ratio = artwork && state === "ready" ? artwork.width / artwork.height : 1;
  return <div className="cd-verse-artwork" data-artwork-state={artwork ? state : "fallback"}
    style={{ "--verse-art-ratio": ratio } as CSSProperties}>
    <div className="cd-verse-art-content" dir={direction} aria-hidden="true" data-covered={state === "ready" ? "" : undefined}>
      {children}
    </div>
    {artwork && state !== "failed" && <figure className="cd-verse-official-art" hidden={state !== "ready"}>
      <img alt={reference} src={artwork.url} width={artwork.width} height={artwork.height} referrerPolicy="no-referrer"
        onLoad={event => setState(event.currentTarget.naturalWidth > 0 ? "ready" : "failed")}
        onError={() => setState("failed")} />
      <figcaption dir="auto">{artwork.attribution}</figcaption>
    </figure>}
  </div>;
}

function localDate() {
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(n => String(n).padStart(2, "0")).join("-");
}

function validSelection(value: unknown, date: string, language: Language): value is DailySelection {
  if (!value || typeof value !== "object") return false;
  const selection = value as Partial<DailySelection>;
  return selection.date === date && selection.language === language
    && typeof selection.passageId === "string" && /^[A-Z0-9]{3}\.\d{1,3}\.\d{1,3}(?:-\d{1,3})?$/.test(selection.passageId);
}

function validVerse(selection: DailySelection): selection is Verse {
  const verse = selection as Partial<Verse>;
  return typeof verse.languageTag === "string" && verse.languageTag.toLowerCase().split("-")[0] === selection.language
    && typeof verse.version === "number" && Number.isSafeInteger(verse.version) && verse.version > 0
    && [verse.text, verse.reference, verse.attribution].every(text => typeof text === "string" && text.trim() && text.length <= 5000);
}

export function DailyVerse({ language, desktop }: { language: Language; desktop: boolean }) {
  const t = (key: string) => translate(language, key);
  const [date, setDate] = useState(localDate);
  const [loaded, setSelection] = useState<DailySelection | null>(null);
  const selection = loaded?.language === language && loaded.date === date ? loaded : null;
  const official = selection && validVerse(selection) ? selection : null;
  const artwork = selection ? matchingArtwork(selection) : null;
  const bundled = official ? null : offlineDailyVerse(date, language, selection?.passageId);
  const offline = artwork && bundled?.passageId !== artwork.passageId ? null : bundled;
  const verse = official ?? offline;
  const [provider, setProvider] = useState("offline");
  const [notice, setNotice] = useState("");
  const artworkKey = artwork ? JSON.stringify([date, language, artwork.passageId, artwork.url]) : "";

  useEffect(() => {
    const refresh = () => setDate(localDate());
    const timer = window.setInterval(refresh, 1000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), 2800);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  useEffect(() => {
    setNotice("");
    const configured = import.meta.env.VITE_YOUVERSION_VERSE_URL;
    const endpoint = httpsUrl(configured);
    if (!endpoint) {
      setProvider(configured ? "invalid-endpoint" : "unconfigured");
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    let mounted = true;
    endpoint.searchParams.set("date", date);
    endpoint.searchParams.set("language", language);
    setProvider("loading");
    void fetch(endpoint, { signal: controller.signal, credentials: "omit", redirect: "error", cache: "no-store" })
      .then(async response => {
        if (!response.ok) {
          if (mounted) setProvider(`endpoint-http-${response.status}`);
          return;
        }
        const value: unknown = await response.json().catch(() => null);
        if (!mounted) return;
        if (validSelection(value, date, language)) {
          setSelection(value);
          setProvider(validVerse(value) ? "verified" : "offline-daily-passage");
        } else {
          setProvider("response-rejected");
        }
      })
      .catch(() => { if (mounted) setProvider(controller.signal.aborted ? "timeout" : "network-error"); })
      .finally(() => window.clearTimeout(timeout));
    return () => { mounted = false; window.clearTimeout(timeout); controller.abort(); };
  }, [date, language]);

  const verseUrl = official ? `https://www.bible.com/bible/${official.version}/${official.passageId}` : offline?.verseUrl;
  const chapterUrl = official ? `https://www.bible.com/bible/${official.version}/${official.passageId.split(".").slice(0, 2).join(".")}` : offline?.chapterUrl;
  const imagePassageUrl = artwork ? `https://www.bible.com/bible/compare/${artwork.passageId}` : undefined;
  const bibleUrl = (official ? verseUrl : offline?.bibleUrl) ?? imagePassageUrl;
  const bibleVersion = offline && (language === "en" ? "WEBUS" : language === "bg" ? "РИ ББД" : undefined);
  const licenseUrl = offline?.licenseUrl;
  const shareText = verse ? [verse.text, verse.reference, verse.attribution, offline?.sourceUrl, offline?.licenseUrl].filter(Boolean).join("\n") : "";
  const open = async (url: string) => {
    try {
      if (desktop) await (await import("@tauri-apps/plugin-shell")).open(url);
      else window.open(url, "_blank", "noopener,noreferrer");
    } catch { setNotice("Could not open Bible.com."); }
  };
  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setNotice("Copied");
  };
  const share = async () => {
    if (!verse || !verseUrl) return;
    try {
      if (navigator.share) await navigator.share({ title: verse.reference, text: offline ? shareText : undefined, url: verseUrl });
      else await copy(offline ? `${shareText}\n${verseUrl}` : verseUrl);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) setNotice("Could not share the verse.");
    }
  };
  const direction = languageDirection(language);
  const excerpt = verse ? artworkExcerpt(verse.text, language) : null;
  return <aside className="cd-daily-verse" lang={language} data-verse-provider={provider}>
    <VerseArtwork key={artworkKey} artwork={artwork} direction={direction} reference={verse ? "" : artwork?.passageId ?? ""}>
        <Icon name="book" size={22} />
        <p lang={verse?.languageTag} dir="auto">{excerpt?.text ?? t("Today's verse is unavailable.")}</p>
        {verse && <cite lang={verse.languageTag} dir="auto">{verse.reference}</cite>}
        {excerpt?.shortened && <small>{t("Passage preview")}</small>}
    </VerseArtwork>
    <div className="cd-daily-reading" dir={direction}>
      <h3><Icon name="book" size={34} /><span>{language === "en" ? "Verse of the Day" : t("Bible Verse of the Day")}</span></h3>
      {verse ? <>
        <blockquote lang={verse.languageTag} dir="auto"><span className="cd-verse-text">{verse.text}</span></blockquote>
        <strong lang={verse.languageTag} dir="auto">{verse.reference}</strong>
        <small dir="auto" className="cd-daily-credit">
          <bdi>{verse.attribution}</bdi> · {offline ? <>
            <button type="button" className="cd-daily-source" onClick={() => void open(offline.sourceUrl)}>{t("Sion Keys offline selection")}</button>
            {licenseUrl && <> · <button type="button" className="cd-daily-source" onClick={() => void open(licenseUrl)}>{licenseUrl.includes("by-nd") ? "CC BY-ND 4.0" : "CC BY-SA 4.0"}</button></>}
          </> : <bdi>YouVersion</bdi>}
        </small>
      </> : artwork ? <strong dir="ltr">{artwork.passageId.replace(".", " ").replace(".", ":")}</strong>
        : <p role="status">{t(provider === "loading" ? "Loading verse…" : "Today's verse is unavailable.")}</p>}
      <div className="cd-daily-actions">
        {verse && chapterUrl && <>
          <button type="button" className="btn btn-primary" onClick={() => void open(chapterUrl)}><Icon name="book" size={20} />{t("Read Full Chapter")}</button>
          <button type="button" className="btn btn-ghost" onClick={() => void copy(`${shareText}\n${verseUrl}`).catch(() => setNotice("Could not copy the verse."))}><Icon name="copy" size={20} />{t("Copy")}</button>
          <button type="button" className="btn btn-ghost" onClick={() => void share()}><Icon name="share" size={20} />{t("Share")}</button>
        </>}
        <button type="button" className="btn btn-ghost" title={bibleVersion || undefined} onClick={() => void open(bibleUrl || "https://www.bible.com/verse-of-the-day")}><Icon name="external" size={20} />Bible.com</button>
      </div>
    </div>
    <small className="cd-daily-notice" role="status">{notice && t(notice)}</small>
  </aside>;
}

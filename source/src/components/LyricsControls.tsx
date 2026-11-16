import { LYRICS_ONLY_SHEET } from "../lib/singingLyrics";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from "react";
import { translate } from "../lib/i18n";
import { languageDirection, type Language } from "../lib/languages";
import { alternateRecording, candidateLyrics, distinctLyricAlternatives, lyricsOperation, lyricVersions, savedLyricsLanguage, saveLyricsLanguage, type LyricsActionName, type LyricsCandidate, type SmartLookup } from "../lib/smartLyrics";
import { Icon } from "./Icon";
import { formatTime } from "../lib/format";
import { LanguagePicker } from "./LanguagePicker";
import type { ImportedLyrics } from "../lib/smartLyrics";

export type LyricsAction = (action: LyricsActionName, data?: Record<string, unknown>) => Promise<string | ImportedLyrics | null | void>;
const sources = [
  ["Worship Leader", "https://songs.worshipleaderapp.com/"],
  ["OpenSong songbooks", "https://worshipleaderapp.com/en/download-song-database-opensong-openlp-and-quelea/"],
  ["Християнски песни", "https://pesni.propovedi.org/1-50/"],
  ["Текстове на песни", "https://tekstovenapesni.wordpress.com/home/"],
  ["Духовни песни", "https://duhovnipesni.org/index.php"],
  ["Trinity songbook", "https://trinity-bg.org/2frames.php?/songbook/index.html"],
  ["Света Троица", "https://media.holy-trinity.eu/pesni/"],
  ["Витания Казанлък", "https://vitaniakazanlak.blogspot.com/"],
] as const;

async function openSource(url: string) {
  if (!url.startsWith("https://")) return;
  const { open } = await import("@tauri-apps/plugin-shell");
  await open(url);
}

export type LyricsControlsHandle = { open: () => void };

export const LyricsControls = forwardRef<LyricsControlsHandle, {
  lookup: SmartLookup; language: Language; onAction: LyricsAction; manual: boolean; showTools?: boolean;
  actions?: (close: () => void) => ReactNode;
}>(function LyricsControls({ lookup, language, onAction, manual, showTools = true, actions }, ref) {
  const t = (key: string) => translate(language, key);
  const dialog = useRef<HTMLDialogElement>(null);
  const importOptions = useRef<HTMLDetailsElement>(null);
  const reportReason = useRef<HTMLSelectElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [reason, setReason] = useState("wrong-song");

  const [importSource, setImportSource] = useState("");
  const [inspected, setInspected] = useState<string | null>(null);
  const [query, setQuery] = useState(lookup.metadata.title);
  const [searchedTitle, setSearchedTitle] = useState("");
  const [preferred, setPreferred] = useState(lookup.metadata.language);
  const candidate = lookup.candidates.find(item => item.id === lookup.selected);
  const [reviewVersions, setReviewVersions] = useState(false);
  const { best, groups } = useMemo(() => lyricVersions(lookup.candidates, lookup.metadata, lookup.selected),
    [lookup.candidates, lookup.metadata, lookup.selected]);
  const alternatives = useMemo(() => distinctLyricAlternatives(lookup.candidates,
    searchedTitle ? { ...lookup.metadata, title: searchedTitle } : lookup.metadata, lookup.selected),
    [lookup.candidates, lookup.metadata, lookup.selected, searchedTitle]);
  const mismatch = (item: LyricsCandidate) => !item.linkOnly && alternateRecording(item, lookup.metadata);
  const choiceDetails = (item: LyricsCandidate) => [
    item.artist || item.songwriter, item.songNumber ? `#${item.songNumber}` : "", item.language === "unknown" ? t("Language unknown") : item.language,
    item.provider, item.duration > 0 ? formatTime(item.duration) : "",
    item.version !== "unspecified" ? item.version : "",
    item.linkOnly ? t("Open matching song page") : "",
    mismatch(item) ? t("Possible alternate recording") : "",
  ].filter(Boolean).join(" · ");
  useEffect(() => { dialog.current?.close(); setQuery(lookup.metadata.title); setSearchedTitle(""); setPreferred(lookup.metadata.language); setNotice(""); setInspected(null); setReviewVersions(false); }, [lookup.song]);
  const open = (mode: "search" | "versions" | "import" = "search") => {
    setReviewVersions(mode === "versions");
    if (mode === "versions") setReason("wrong-version");
    dialog.current?.showModal();
    if (mode === "import" && importOptions.current) {
      importOptions.current.open = true;
      importOptions.current.scrollIntoView({ block: "nearest" });
    }
  };
  useImperativeHandle(ref, () => ({ open: () => open() }));
  const run = async (work: () => Promise<unknown>, success = "") => {
    setBusy(true); setNotice("");
    try { await work(); setNotice(success); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const reportTarget = lookup.candidates.find(item => item.id === inspected) || candidate;
  const choose = async (id: string) => {
    const item = lookup.candidates.find(value => value.id === id);
    if (item?.linkOnly) { setInspected(id); await openSource(item.sourceUrl); }
    else { await onAction("choose", { candidate: id }); setInspected(null); }
  };
  return <>
    {showTools && <div className="lyrics-tools">
    {!LYRICS_ONLY_SHEET && !manual && lookup.lyrics && !lookup.lyrics.lines.length &&
      <button type="button" className="lyrics-source" onClick={() => open("import")}>{t("Find lyrics")}</button>}
    {candidate && !manual && (candidate.sourceUrl
      ? <button type="button" className="lyrics-source" disabled={busy} onClick={() => void run(() => openSource(candidate.sourceUrl))}>{candidate.provider}</button>
      : <span className="lyrics-source">{candidate.provider}</span>)}
    {candidate && <button type="button" className="lyrics-wrong-version" disabled={busy} onClick={() => open("versions")}>{t("Wrong version?")}</button>}
    {candidate && !manual && mismatch(candidate) &&
      <small className="cd-lyrics-notice">{t("Possible alternate recording")}</small>}
    </div>}
    <dialog className="lyrics-dialog card" ref={dialog} dir={languageDirection(language)} onCancel={() => setNotice("")}>
      <header><h2>{t("Lyrics options")}</h2><button className="cd-icon-btn" aria-label={t("Close")} onClick={() => dialog.current?.close()}><Icon name="close" size={20} /></button></header>
      <div className="lyrics-search-row"><input aria-label={t("Song title")} value={query} maxLength={240} onChange={e => setQuery(e.target.value)} />
        <LanguagePicker kind="lyrics" language={language} value={preferred} onChange={setPreferred} />
        <button className="btn btn-ghost" disabled={busy || lookup.pending || !query.trim()} onClick={() => void run(async () => {
          await onAction("search", { language: preferred, query });
          setSearchedTitle(query.trim());
        })}>{t("Search again")}</button></div>
      {actions && <div className="lyrics-dialog-actions">{actions(() => dialog.current?.close())}</div>}
      {!LYRICS_ONLY_SHEET && <p className="lyrics-help">{t("Different recordings can share lyrics. Timing is used only when the recording matches. Unknown languages require your review.")}</p>}
      {candidate?.copyright && <p className="lyrics-help">{candidate.copyright}</p>}
      {!!lookup.candidates.length && <>
        <p className="lyrics-help">{t("Other versions with different words")}</p>
        <button type="button" className="btn btn-ghost" disabled={busy || lookup.pending}
          onClick={() => void run(() => onAction("auto"))}>{t("Use best match automatically")}</button>
        <div className="lyrics-results">{(manual && candidate?.available && !candidate.linkOnly ? [candidate, ...alternatives] : alternatives).map(item => <button type="button" className="lyrics-result"
          key={item.id} disabled={busy || lookup.pending} onClick={() => void run(async () => {
            await choose(item.id);
            dialog.current?.close();
          })}>
          <strong dir="auto">{item.title}</strong><span dir="auto">{choiceDetails(item)}</span>
          <span className="lyrics-version-badges">{[
            best === item.id && t("Best match"),
            !LYRICS_ONLY_SHEET && !!candidateLyrics(item, lookup.metadata)?.lines.length && t("Synchronized"),
          ].filter(Boolean).join(" · ")}</span>
        </button>)}</div>
        {!alternatives.length && !manual && <p>{t("No other versions with different words were found.")}</p>}
      </>}
      {!lookup.candidates.length && !lookup.shared && <p>{t(lookup.state === "metadata-needed" ? "Enter a song title to find lyrics." : "No matching lyrics")}</p>}
      {lookup.state === "rate-limited" && <p>{t("Lyrics provider is busy. Please try again later.")}</p>}
      {reviewVersions && reportTarget && <div className="lyrics-search-row">
        <select ref={reportReason} aria-label={t("Report incorrect match")} value={reason} onChange={e => setReason(e.target.value)}>
          {[["wrong-song", "Wrong song"], ["wrong-artist", "Wrong artist"], ["wrong-language", "Wrong language"], ["wrong-version", "Wrong version/translation"], ["incomplete", "Incorrect or incomplete lyrics"], ["duplicate", "Duplicate entry"], ["rights", "Copyright/attribution issue"]].map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
        </select><button className="btn btn-ghost" disabled={busy} onClick={() => void run(() => onAction("report", { candidate: reportTarget.id, reason, aliases: groups.find(g => g.ids.includes(reportTarget.id))?.ids.filter(id => id !== reportTarget.id) }), "Saved on this device. This version will not be selected automatically.")}>{t("Report incorrect match")}</button>
      </div>}
      <details ref={importOptions}><summary>{t("Import lyrics or open a songbook")}</summary>
        <p>{t("Import OpenSong, OpenLyrics XML, ChordPro, TXT, LRC, ZIP or Worship Leader OSB (5000 songs / 20 MB compressed).")}</p>
        <label>{t("Songbook source")} <select value={importSource} onChange={e => setImportSource(e.target.value)}>
          <option value="">{t("Local import")}</option>
          {["worshipleader", "propovedi", "tekstove", "duhovni", "trinity", "holytrinity", "vitania"].map((id, index) => <option key={id} value={id}>{sources[index === 0 ? 0 : index + 1][0]}</option>)}
        </select></label>
        <p className="lyrics-help">{t("Songbooks stay on this device. Lyrics are checked against the recording before they can be added to the shared library.")}</p>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void run(async () => {
          const { open } = await import("@tauri-apps/plugin-dialog");
          const path = await open({ multiple: false, directory: false, title: t("Import lyrics") });
          if (typeof path === "string" && await onAction("import", { path, language: preferred, sourceId: importSource })) {
            dialog.current?.close();
          }
        })}>{t("Import lyrics")}</button>
        {lookup.candidates.some(item => item.linkOnly) && <div className="lyrics-source-links">
          {lookup.candidates.filter(item => item.linkOnly).slice(0, 6).map(item => <button key={item.id} type="button"
            onClick={() => void run(() => openSource(item.sourceUrl))}>{item.provider}: {item.title} ↗</button>)}
        </div>}
        <div className="lyrics-source-links">{sources.map(([label, url]) => <button type="button" key={url} onClick={() => void run(() => openSource(url))}>{label} ↗</button>)}</div>
      </details>
      <p className="lyrics-help">{t("Reports stay on this device. Provider lyrics are for viewing; copying and export require separate permission.")}</p>
      {notice && <p role="status">{t(notice)}</p>}
    </dialog>
  </>;
});

export function LyricsSettings({ language, mode }: { language: Language; mode: "language" | "cache" }) {
  const t = (key: string) => translate(language, key);
  const [value, setValue] = useState(savedLyricsLanguage);
  const [notice, setNotice] = useState("");
  const [bytes, setBytes] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (mode === "cache") void lyricsOperation<{bytes: number}>({ action: "stats" }).then(r => setBytes(r.bytes)).catch(() => {}); }, [mode]);
  if (mode === "language") return <div className="lyrics-settings">
    <span>{t("Preferred lyrics language")}</span>
    <LanguagePicker kind="lyrics" language={language} value={value} onChange={choice => {
      saveLyricsLanguage(choice);
      setValue(choice);
    }} />
  </div>;
  return <div className="lyrics-settings">
    <button type="button" className="btn btn-ghost" disabled={busy} title={t("Keeps imported lyrics, corrections and History.")} onClick={async () => {
      setBusy(true);
      try { await lyricsOperation({ action: "clear" }); setNotice("Lyrics cache cleared. Imports and corrections kept."); const stats = await lyricsOperation<{bytes: number}>({ action: "stats" }); setBytes(stats.bytes); }
      catch { setNotice("Could not clear lyrics cache."); } finally { setBusy(false); }
    }}>{t("Clear Lyrics Cache")}</button>
    <small>{t("Lyrics library")}: {bytes === null ? "—" : (bytes / 1024).toLocaleString(language, { maximumFractionDigits: 1 }) + " KiB"}</small>
    {notice && <small role="status">{t(notice)}</small>}
  </div>;
}

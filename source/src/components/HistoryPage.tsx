import { useMemo, useState } from "react";
import { languageDirection, type Language } from "../lib/languages";
import { localizedKey, translate } from "../lib/i18n";
import { formatTime } from "../lib/format";
import { isLikelyYoutubeUrl, youtubeVideoId } from "../lib/engine";
import type { HistoryEntry } from "../lib/types";
import { Icon } from "./Icon";
import { SongArt } from "./Artwork";

type Source = "local" | "youtube" | "older";
type SortOrder = "new" | "old" | "long" | "name";
const PAGE_SIZE = 6;
const SOURCE_LABEL = { local: "Local file", youtube: "YouTube", older: "Older entry" };
const SOURCE_ICON = { local: "folder", youtube: "youtube", older: "clock" };

function sourceOf(entry: HistoryEntry): Source {
  return entry.url ? "youtube" : entry.path || entry.result ? "local" : "older";
}

export function HistoryPage(p: {
  language: Language;
  history: HistoryEntry[];
  busy: boolean;
  onReopen: (entry: HistoryEntry, autoplay: boolean) => void;
  onDownload?: (entries: HistoryEntry[]) => void;
  onRemove: (entry: HistoryEntry) => void;
  onRemoveSelected: (entries: HistoryEntry[]) => void;
  onClearHistory: () => void;
}) {
  const t = (key: string, params?: Record<string, string | number>) => translate(p.language, key, params);
  const dir = languageDirection(p.language);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<"all" | Source>("all");
  const [keyFilter, setKeyFilter] = useState("");
  const [sort, setSort] = useState<SortOrder>("new");
  const [failedThumbs, setFailedThumbs] = useState<Set<string>>(() => new Set());
  const [menuId, setMenuId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const keys = useMemo(() => [...new Set(p.history.map(entry => entry.keyLabel).filter(Boolean))].sort(), [p.history]);
  const { totalTime, thisMonth } = useMemo(() => {
    const now = new Date();
    let totalTime = 0;
    let thisMonth = 0;
    for (const entry of p.history) {
      const date = new Date(entry.analyzedAt);
      if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) thisMonth++;
      if (Number.isFinite(entry.durationSec)) totalTime += Math.max(0, entry.durationSec);
    }
    return { totalTime, thisMonth };
  }, [p.history]);

  const effectiveKey = keys.includes(keyFilter) ? keyFilter : "";
  const rows = useMemo(() => {
    const q = query.trim().toLocaleLowerCase(p.language);
    const filtered = p.history.filter(entry =>
      (source === "all" || sourceOf(entry) === source) &&
      (!effectiveKey || entry.keyLabel === effectiveKey) &&
      (!q || entry.name.toLocaleLowerCase(p.language).includes(q)));
    if (sort === "new") filtered.sort((a, b) => b.analyzedAt.localeCompare(a.analyzedAt));
    if (sort === "old") filtered.sort((a, b) => a.analyzedAt.localeCompare(b.analyzedAt));
    if (sort === "long") filtered.sort((a, b) => (b.durationSec || 0) - (a.durationSec || 0));
    if (sort === "name") filtered.sort((a, b) => a.name.localeCompare(b.name, p.language));
    return filtered;
  }, [p.history, query, source, effectiveKey, sort, p.language]);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const offset = (currentPage - 1) * PAGE_SIZE;
  const visible = rows.slice(offset, offset + PAGE_SIZE);
  const selection = rows.filter(entry => selected.has(entry.id));
  const downloadableSelection = selection.filter(entry => entry.url ? isLikelyYoutubeUrl(entry.url) : !!entry.path);
  const allVisibleSelected = visible.length > 0 && visible.every(entry => selected.has(entry.id));
  const someVisibleSelected = visible.some(entry => selected.has(entry.id));
  const dateFormat = new Intl.DateTimeFormat(p.language, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  function changePage(next: number) {
    setPage(next);
    setMenuId(null);
  }

  function resetFilter() {
    changePage(1);
    setSelected(new Set());
  }

  function toggle(entries: HistoryEntry[], checked: boolean) {
    setSelected(previous => {
      const next = new Set(previous);
      for (const entry of entries) {
        if (checked) next.add(entry.id);
        else next.delete(entry.id);
      }
      return next;
    });
  }

  return (
    <div className="hy-wrap" dir={dir}>
      <div className="hy-stats">
        <div className="card hy-stat"><Icon name="music" size={29} /><div><strong>{p.history.length.toLocaleString(p.language)}</strong><span>{t("Analyzed songs")}</span></div></div>
        <div className="card hy-stat"><Icon name="calendar" size={29} /><div><strong>{t("This month")}</strong><span>{t("Analyses: {count}", { count: thisMonth.toLocaleString(p.language) })}</span></div></div>
        <div className="card hy-stat"><Icon name="clock" size={29} /><div><strong>{t("Total time")}</strong><span><bdi>{formatTime(totalTime)}</bdi></span></div></div>
      </div>

      <div className="hy-toolbar">
        <label className="hy-search">
          <Icon name="search" size={18} />
          <input type="search" value={query} placeholder={t("Search in history…")} aria-label={t("Search in history…")} onChange={e => { setQuery(e.target.value); resetFilter(); }} />
        </label>
        <label className="hy-filter"><Icon name="youtube" size={18} />
          <select className="themed-select" value={source} aria-label={t("Filter by source")} onChange={e => { setSource(e.target.value as typeof source); resetFilter(); }}>
            <option value="all">{t("All sources")}</option>
            <option value="local">{t("Local file")}</option>
            <option value="youtube">{t("YouTube")}</option>
            <option value="older">{t("Older entry")}</option>
          </select>
        </label>
        <label className="hy-filter"><Icon name="key" size={18} />
          <select className="themed-select" value={effectiveKey} aria-label={t("Any key")} onChange={e => { setKeyFilter(e.target.value); resetFilter(); }}>
            <option value="">{t("Any key")}</option>
            {keys.map(key => <option key={key} value={key}>{localizedKey(p.language, key)}</option>)}
          </select>
        </label>
        <label className="hy-filter"><Icon name="sort" size={18} />
          <select className="themed-select" value={sort} aria-label={t("Sort history")} onChange={e => { setSort(e.target.value as SortOrder); changePage(1); }}>
            <option value="new">{t("Newest first")}</option>
            <option value="old">{t("Oldest first")}</option>
            <option value="long">{t("Longest first")}</option>
            <option value="name">{t("Name (A–Z)")}</option>
          </select>
        </label>
        <button type="button" className="btn btn-ghost hy-delete" disabled={!p.history.length} onClick={p.onClearHistory}><Icon name="trash" size={17} />{t("Clear history")}</button>
      </div>

      {!visible.length && <div className="card hy-empty">{t(p.history.length ? "No songs match the current search or filters." : "Analyze a song to see it listed here, then re-open it without searching for the file.")}</div>}
      {!!visible.length && <ul className="card hy-list">
        {visible.map((entry, index) => {
          const src = sourceOf(entry);
          const checked = selected.has(entry.id);
          const date = new Date(entry.analyzedAt);
          const dateText = Number.isFinite(date.getTime()) ? dateFormat.format(date) : "—";
          const youtube = entry.url && isLikelyYoutubeUrl(entry.url);
          const videoId = youtube ? youtubeVideoId(entry.url!) : null;
          const downloadable = !!p.onDownload && (entry.url ? youtube : !!entry.path);
          return (
            <li key={entry.id} className="hy-row" data-selected={checked}>
              <input type="checkbox" className="hy-check" checked={checked} aria-label={entry.name} onChange={e => toggle([entry], e.target.checked)} />
              <button type="button" className={`hy-art hy-art-${src}`} disabled={p.busy} aria-label={t("Re-open")} onClick={() => p.onReopen(entry, src === "local")}>
                <SongArt className="hy-art-img" />
                {videoId && !failedThumbs.has(videoId) && <img className="hy-thumb"
                  src={`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`} alt="" loading="lazy" referrerPolicy="no-referrer"
                  onError={() => setFailedThumbs(previous => new Set(previous).add(videoId))} />}
                <span className="hy-art-play"><Icon name={src === "youtube" ? "play" : "music"} size={15} /></span>
              </button>
              <div className="hy-copy">
                <strong className="hy-name" title={entry.name}><bdi>{entry.name}</bdi></strong>
                <span className={`hy-meta hy-meta-${src}`} title={youtube ? entry.url : undefined}>{src === "youtube" ? <svg className="hy-youtube-logo" viewBox="0 0 24 17" width="19" height="14" aria-hidden="true"><rect width="24" height="17" rx="4" fill="#ff0033" /><path d="M10 4.8v7.4l6-3.7Z" fill="white" /></svg> : <Icon name={SOURCE_ICON[src]} size={15} />}{videoId ? <a className="hy-source-link" href={`https://www.youtube.com/watch?v=${videoId}`} target="_blank" rel="noreferrer"
                  onClick={event => {
                    if (!p.onDownload) return;
                    event.preventDefault();
                    const url = event.currentTarget.href;
                    void import("@tauri-apps/plugin-shell").then(({ open }) => open(url)).catch(() => {});
                  }}><bdi>{entry.url}</bdi><Icon name="external" size={14} /></a> : <bdi>{t(SOURCE_LABEL[src])}</bdi>}</span>
              </div>
              <div className="hy-details">
                <div><bdi className="hy-key">{localizedKey(p.language, entry.keyLabel)}</bdi><span className="hy-duration"><Icon name="clock" size={15} /><bdi>{formatTime(entry.durationSec)}</bdi></span></div>
                <span className="hy-date"><Icon name="calendar" size={15} /><bdi>{dateText}</bdi></span>
              </div>
              <button type="button" className="btn btn-primary hy-reopen" disabled={p.busy} onClick={() => p.onReopen(entry, false)}><Icon name="play" size={15} />{t("Re-open")}</button>
              <button type="button" className="btn btn-ghost hy-download" disabled={p.busy || !downloadable} onClick={() => p.onDownload?.([entry])}><Icon name="download" size={17} />{t("Download MP3")}</button>
              <div className="hy-kebab-wrap">
                <button type="button" className="hy-kebab" aria-label={t("More actions")} aria-expanded={menuId === entry.id} onClick={() => setMenuId(menuId === entry.id ? null : entry.id)} onKeyDown={e => { if (e.key === "Escape") setMenuId(null); }}>
                  <span aria-hidden="true">⋮</span>
                </button>
                {menuId === entry.id && <>
                  <div className="hy-menu-scrim" onClick={() => setMenuId(null)} />
                  <div className={`cd-menu hy-menu${index >= 4 ? " hy-menu-up" : ""}`} role="menu" onKeyDown={e => { if (e.key === "Escape") setMenuId(null); }}>
                    <button type="button" role="menuitem" disabled={p.busy} onClick={() => { setMenuId(null); p.onReopen(entry, false); }}>{t("Re-open")}</button>
                    <button type="button" role="menuitem" onClick={() => { setMenuId(null); p.onRemove(entry); }}>{t("Remove from history")}</button>
                  </div>
                </>}
              </div>
            </li>
          );
        })}
      </ul>}

      <div className="card hy-footer">
        <label className="hy-selection">
          <input type="checkbox" className="hy-check" checked={allVisibleSelected} disabled={!visible.length}
            ref={input => { if (input) input.indeterminate = someVisibleSelected && !allVisibleSelected; }}
            aria-label={t("Select this page")} onChange={e => toggle(visible, e.target.checked)} />
          <span aria-live="polite">{t("{count} selected", { count: selection.length.toLocaleString(p.language) })}</span>
        </label>
        <button type="button" className="btn btn-ghost" disabled={p.busy || !p.onDownload || !downloadableSelection.length}
          onClick={() => p.onDownload?.(downloadableSelection)}><Icon name="download" size={16} />{t("Download")}</button>
        <button type="button" className="btn btn-ghost hy-delete hy-delete-selected" disabled={!selection.length} onClick={() => p.onRemoveSelected(selection)}><Icon name="trash" size={16} />{t("Delete")}</button>
        <nav className="hy-pagination" aria-label={t("Pages")}>
          <span><bdi>{t("{start}–{end} of {total}", { start: rows.length ? offset + 1 : 0, end: offset + visible.length, total: rows.length })}</bdi></span>
          <button type="button" disabled={currentPage === 1} aria-label={t("Previous page")} onClick={() => changePage(currentPage - 1)}><Icon name={dir === "rtl" ? "chevron" : "chevronLeft"} size={16} /></button>
          {Array.from({ length: pageCount }, (_, index) => index + 1).map(number =>
            <button type="button" key={number} aria-current={number === currentPage ? "page" : undefined} onClick={() => changePage(number)}>{number.toLocaleString(p.language)}</button>)}
          <button type="button" disabled={currentPage === pageCount} aria-label={t("Next page")} onClick={() => changePage(currentPage + 1)}><Icon name={dir === "rtl" ? "chevronLeft" : "chevron"} size={16} /></button>
        </nav>
      </div>
    </div>
  );
}

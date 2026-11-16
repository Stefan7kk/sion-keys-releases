import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { searchYoutube, youtubeVideoId, youtubeWatchUrl, type YouTubeVideo } from "../lib/engine";
import { formatTime } from "../lib/format";
import { translate } from "../lib/i18n";
import { languageDirection, type Language } from "../lib/languages";
import { readYoutubeFavorites, toggleYoutubeFavorite, youtubeFavoritesKey } from "../lib/youtubeFavorites";
import { Icon } from "./Icon";

type Props = {
  value: string;
  onChange: (value: string) => void;
  onAnalyze: () => void;
  disabled: boolean;
  canAnalyze: boolean;
  desktop: boolean;
  language: Language;
  searchRequested: boolean;
  onSearchFocused: () => void;
};

export function YoutubeInput({ value, onChange, onAnalyze, disabled, canAnalyze, desktop, language, searchRequested, onSearchFocused }: Props) {
  const t = (key: string) => translate(language, key);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const clear = useRef<HTMLButtonElement>(null);
  const analyzeButton = useRef<HTMLButtonElement>(null);
  const request = useRef<Promise<YouTubeVideo[]> | null>(null);
  const id = useId();
  const [mode, setMode] = useState<"search" | "favorites">("search");
  const [favorites, setFavorites] = useState(() => {
    try { return readYoutubeFavorites(localStorage.getItem(youtubeFavoritesKey)); }
    catch { return []; }
  });
  const [favoriteError, setFavoriteError] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const [selected, setSelected] = useState<YouTubeVideo | null>(null);
  const [hint, setHint] = useState("");
  const [response, setResponse] = useState<{ query: string; videos: YouTubeVideo[] | null } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const videoId = youtubeVideoId(value);
  const query = value.trim();
  const canSearch = mode === "search" && query.length >= 2 && query.length <= 160
    && !videoId && !/^(?:[a-z][a-z\d+.-]*:\/\/|(?:www\.|m\.|music\.)?youtube\.com|youtu\.be)/i.test(query);
  const visible = !!position && !disabled;
  const result = canSearch && response?.query === query ? response : null;
  const videos = mode === "favorites" ? favorites : result?.videos ?? [];
  const listLabel = mode === "favorites" ? t("Favorites") : t("YouTube Search");
  const activeIndex = Math.min(highlight, Math.max(0, videos.length - 1));
  const show = useCallback(() => {
    const rect = box.current?.getBoundingClientRect();
    if (rect) setPosition({ left: rect.left, top: rect.bottom + 4, width: rect.width, maxHeight: window.innerHeight - rect.bottom - 15 });
  }, []);
  useLayoutEffect(() => {
    if (!searchRequested || disabled) return;
    setMode("search");
    input.current?.focus();
    input.current?.select();
    show();
    onSearchFocused();
  }, [searchRequested, disabled, onSearchFocused, show]);

  useEffect(() => {
    if (disabled) setPosition(null);
  }, [disabled]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.storageArea === localStorage && (event.key === youtubeFavoritesKey || event.key === null)) {
        setFavorites(readYoutubeFavorites(event.newValue));
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const dismiss = (event: PointerEvent | FocusEvent) => {
      const target = event.target as Node;
      if (!box.current?.contains(target) && !popup.current?.contains(target)) setPosition(null);
    };
    const close = () => setPosition(null);
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
      window.removeEventListener("resize", close);
    };
  }, [visible]);

  useEffect(() => {
    if (!visible || !canSearch || !desktop || result) return;
    let stale = false;
    const timer = window.setTimeout(async () => {
      await request.current?.catch(() => undefined);
      if (stale) return;
      const current = searchYoutube(query);
      request.current = current;
      try {
        const videos = await current;
        if (!stale) setResponse({ query, videos });
      } catch {
        if (!stale) setResponse({ query, videos: null });
      } finally {
        if (request.current === current) request.current = null;
      }
    }, 450);
    return () => { stale = true; window.clearTimeout(timer); };
  }, [visible, canSearch, desktop, query, result]);

  const select = (video: YouTubeVideo) => {
    setSelected(video);
    setHint("");
    onChange(youtubeWatchUrl(video.id));
    input.current?.focus();
    setPosition(null);
  };
  const switchMode = (next: "search" | "favorites") => {
    setMode(next);
    setHint("");
    setFavoriteError(false);
    setHighlight(0);
  };
  const toggleFavorite = (video: YouTubeVideo, index: number, button: HTMLButtonElement) => {
    try {
      const next = toggleYoutubeFavorite(localStorage, video);
      if (mode === "favorites" && !next.some(item => item.id === video.id) && document.activeElement === button) {
        const hearts = popup.current?.querySelectorAll<HTMLButtonElement>(".cd-youtube-heart");
        (hearts?.[index + 1] ?? hearts?.[index - 1]
          ?? popup.current?.querySelector<HTMLButtonElement>('.cd-youtube-modes button[aria-pressed="true"]'))?.focus();
      }
      setFavorites(next);
      setFavoriteError(false);
    } catch {
      setFavoriteError(true);
    }
  };
  const analyze = () => {
    if (canAnalyze) {
      setPosition(null);
      setHint("");
      onAnalyze();
    } else {
      input.current?.focus();
      show();
      if (mode === "search" && !canSearch) setHint("Paste a single-video YouTube link first.");
    }
  };
  const openYoutube = async () => {
    const url = "https://www.youtube.com/results?search_query=" + encodeURIComponent(query);
    try {
      if (desktop) {
        const { open } = await import("@tauri-apps/plugin-shell");
        await open(url);
      } else window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      setHint("YouTube search unavailable");
    }
  };

  return <div className="cd-urlbox" ref={box}>
    <div className="cd-url">
      <Icon name={videoId ? "link" : "youtube"} className={videoId ? undefined : "cd-youtube-icon"} size={22} />
      <input ref={input} type="text" spellCheck={false} disabled={disabled} dir="auto"
        role="combobox" aria-label={t("Search YouTube or paste a link")} aria-expanded={visible} aria-controls={visible ? id : undefined}
        aria-haspopup="grid"
        aria-autocomplete="list" aria-activedescendant={visible && videos.length ? id + "-" + activeIndex : undefined}
        placeholder={t("Search YouTube or paste a link")}
        value={selected && selected.id === videoId ? selected.title : value}
        onFocus={show} onClick={show}
        onChange={event => {
          const next = event.currentTarget.value;
          setSelected(null);
          setHint("");
          setFavoriteError(false);
          setResponse(null);
          setHighlight(0);
          setMode("search");
          onChange(next);
          show();
        }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape" && visible) { event.stopPropagation(); setPosition(null); return; }
          if (event.key === "Tab" && visible && !event.shiftKey) {
            event.preventDefault();
            popup.current?.querySelector<HTMLButtonElement>(".cd-youtube-modes button")?.focus();
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            if (visible && videos[activeIndex]) select(videos[activeIndex]);
            else analyze();
          }
          if (event.key === "ArrowDown" && !visible) {
            event.preventDefault();
            show();
          } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && visible && videos.length) {
            event.preventDefault();
            const index = (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + videos.length) % videos.length;
            setHighlight(index);
            document.getElementById(id + "-" + index)?.scrollIntoView({ block: "nearest" });
          }
        }} />
      {value && <button ref={clear} type="button" className="cd-clear-url" disabled={disabled} aria-label={t("Reset")}
        onClick={() => { setSelected(null); setResponse(null); switchMode("search"); onChange(""); input.current?.focus(); show(); }}><Icon name="close" size={12} /></button>}
    </div>
    <button ref={analyzeButton} type="button" className="cd-analyze" disabled={disabled} onClick={analyze}><Icon name="play" size={22} /><bdi>{t("Analyze")}</bdi></button>
    {visible && createPortal(<div className="cd-youtube-popup" ref={popup} style={position!}
      lang={language} dir={languageDirection(language)}
      onKeyDown={event => {
        if (event.key === "Escape") {
          event.stopPropagation();
          input.current?.focus();
          setPosition(null);
        }
        if (event.key === "Tab") {
          const buttons = popup.current?.querySelectorAll<HTMLButtonElement>("button");
          if (event.shiftKey && event.target === buttons?.[0]) {
            event.preventDefault();
            input.current?.focus();
          } else if (!event.shiftKey && event.target === buttons?.[buttons.length - 1]) {
            event.preventDefault();
            (clear.current ?? analyzeButton.current)?.focus();
            setPosition(null);
          }
        }
      }}>
      <div className="cd-youtube-modes" role="group" aria-label="YouTube">
        <button type="button" aria-pressed={mode === "search"} onClick={() => switchMode("search")}><Icon name="search" size={19} />{t("YouTube Search")}</button>
        <button type="button" aria-pressed={mode === "favorites"} onClick={() => switchMode("favorites")}><Icon name="heart" size={19} />{t("Favorites")}</button>
      </div>
      <div id={id} className="cd-youtube-results" role="grid" aria-label={listLabel}>
        {videos.map((video, index) => {
          const saved = favorites.some(item => item.id === video.id);
          return <div className="cd-youtube-row" role="row" key={video.id}
            onPointerMove={() => setHighlight(index)} onFocus={() => setHighlight(index)}>
            <div role="gridcell">
              <button type="button" className="cd-youtube-heart" aria-pressed={saved}
                aria-label={`${t("Favorites")} · ${video.title}`}
                title={saved ? t("Remove from Favorites") : t("Add to Favorites")}
                onClick={event => toggleFavorite(video, index, event.currentTarget)}>
                <Icon name="heart" size={19} />
              </button>
            </div>
            <div role="gridcell" id={id + "-" + index} aria-selected={index === activeIndex}>
              <button type="button" className="cd-youtube-result" onClick={() => select(video)}>
                <span className="cd-youtube-thumb">
                  {mode === "search"
                    ? <img src={"https://i.ytimg.com/vi/" + video.id + "/mqdefault.jpg"} alt="" loading="lazy" referrerPolicy="no-referrer" />
                    : <Icon name="youtube" size={29} />}
                  {video.duration != null && <bdi>{formatTime(video.duration)}</bdi>}
                </span>
                <span className="cd-youtube-meta"><strong dir="auto">{video.title}</strong>
                  <small dir="auto">{[video.channel, video.views != null ? new Intl.NumberFormat(language, { notation: "compact" }).format(video.views) : null].filter(Boolean).join(" · ")}</small></span>
                {index === activeIndex && <span className="cd-youtube-select" aria-hidden="true">{t("Select")}</span>}
              </button>
            </div>
          </div>;
        })}
      </div>
      {favoriteError && <p role="status">{t("Could not save favorites on this device.")}</p>}
      {!videos.length && <p role="status">{mode === "favorites" ? t("Save a video with the heart to find it here.")
        : t(hint || (!canSearch ? "Search YouTube or paste a link"
          : !desktop || result?.videos === null ? "YouTube search unavailable" : result ? "No videos found" : "Searching YouTube…"))}</p>}
      {canSearch && <button type="button" className="cd-youtube-external" onClick={() => void openYoutube()}>
        <Icon name="search" size={18} /><span>{t("Search on YouTube")} · <bdi>{query}</bdi></span><Icon name="external" size={17} />
      </button>}
    </div>, document.body)}
  </div>;
}

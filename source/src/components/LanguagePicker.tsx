import { useEffect, useId, useMemo, useRef, useState } from "react";
import { isLanguage, languageDirection, languages, type Language, type LyricsLanguage } from "../lib/languages";
import { translate } from "../lib/i18n";
import { Icon } from "./Icon";

const englishNames = new Intl.DisplayNames(["en"], { type: "language" });
const interfaceOptions = Object.keys(languages).filter(isLanguage);
const quickLyricsLanguages = ["bg", "tr", "en"] as const;
const lyricsOptions: LyricsLanguage[] = ["auto", ...quickLyricsLanguages,
  ...interfaceOptions.filter(code => code !== "bg" && code !== "tr" && code !== "en")];
const searchText = (value: string, locale: string) => value.toLocaleLowerCase(locale).normalize("NFD").replace(/\p{M}/gu, "");

type Props =
  | { kind?: "interface"; value: Language; onChange: (value: Language) => void }
  | { kind: "lyrics"; language: Language; value: LyricsLanguage; onChange: (value: LyricsLanguage) => void };

export function LanguagePicker(props: Props) {
  const lyrics = props.kind === "lyrics";
  const locale = lyrics ? props.language : props.value;
  const { value } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    if (lyrics) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [lyrics, open]);
  const displayNames = useMemo(() => new Intl.DisplayNames([locale], { type: "language" }), [locale]);
  const t = (key: string, params?: Record<string, string | number>) => translate(locale, key, params);
  const nameOf = (code: LyricsLanguage) => code === "auto" ? t("Auto-detect") : languages[code][0];
  const term = query.trim();
  const options = (lyrics ? lyricsOptions : interfaceOptions).filter(code => {
    const names = code === "auto" ? `auto ${nameOf(code)}`
      : `${code} ${nameOf(code)} ${englishNames.of(code)} ${displayNames.of(code)}`;
    return searchText(names, "en").includes(searchText(term, "en"))
      || searchText(names, locale).includes(searchText(term, locale));
  });
  const close = () => {
    if (lyrics && panel.current?.matches(":popover-open")) panel.current.hidePopover();
    setQuery("");
    setOpen(false);
    trigger.current?.focus();
  };
  const choose = (code: LyricsLanguage) => {
    if (props.kind === "lyrics") props.onChange(code);
    else if (code !== "auto") props.onChange(code);
    close();
  };
  const languageLabel = t(lyrics ? "Preferred lyrics language" : "Interface language");
  return <div className={lyrics ? "lyrics-language-picker" : "language-picker"} ref={root} onKeyDown={event => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }} onBlur={event => {
    if (!lyrics && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button ref={trigger} type="button" className="language-trigger" aria-label={lyrics ? `${languageLabel} · ${nameOf(value)}` : t("Interface language: {language}", { language: nameOf(value) })}
      aria-expanded={open} aria-controls={id} popoverTarget={lyrics ? id : undefined}
      onClick={() => {
        if (!lyrics) setOpen(!open);
        if (!lyrics || !panel.current?.matches(":popover-open")) setQuery("");
      }}>
      {!lyrics && <Icon name="globe" size={18} />}<bdi>{nameOf(value)}</bdi><Icon name="chevronDown" size={14} />
    </button>
    {(lyrics || open) && <section ref={panel} id={id} className={lyrics ? "language-panel lyrics-language-panel" : "language-panel"}
      aria-label={languageLabel} dir={languageDirection(locale)} popover={lyrics ? "auto" : undefined}
      onToggle={lyrics ? event => {
        const visible = event.currentTarget.matches(":popover-open");
        setOpen(visible);
        if (!visible) setQuery("");
      } : undefined}>
      <label htmlFor={`${id}-search`}>{languageLabel}</label>
      <input ref={search} id={`${id}-search`} type="search" aria-label={t("Search languages…")} placeholder={t("Search languages…")} value={query}
        onChange={event => setQuery(event.currentTarget.value)} onKeyDown={event => {
          if (event.key === "ArrowDown") { event.preventDefault(); root.current?.querySelector<HTMLButtonElement>(".language-option")?.focus(); }
          if (event.key === "Enter" && options.length === 1) { event.preventDefault(); choose(options[0]); }
        }} />
      <div className="language-options" onKeyDown={event => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}>
        {options.map(code => <button type="button" key={code} className="language-option" aria-pressed={code === value}
          onClick={() => choose(code)}>
          <span><bdi lang={code === "auto" ? undefined : code}>{nameOf(code)}</bdi>
            {code !== "auto" && (!lyrics || displayNames.of(code) !== nameOf(code)) && <small><bdi>{displayNames.of(code)}</bdi></small>}
          </span>
          {code === value && <Icon name="check" size={17} />}
        </button>)}
        {!options.length && <p role="status">{t("No matching languages.")}</p>}
      </div>
      {!lyrics && <p className="language-note">{t("Choose your interface language.")}</p>}
    </section>}
  </div>;
}

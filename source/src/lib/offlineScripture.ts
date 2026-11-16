import data from "./offline-scripture.json";
import type { Language } from "./languages";

type Edition = {
  id: string;
  title: string;
  source: string;
  books: Record<string, string>;
  verses: Record<string, string>;
  copyright?: string;
  license?: "by-nd" | "by-sa";
};

const editions: Partial<Record<Language, Edition>> = data.editions as Record<string, Edition>;
const dayMs = 86_400_000;
// Bible.com reader editions. The linked Bulgarian edition is РИ ББД, the
// preferred online edition; the offline quote retains its own attribution.
const bibleReaders: Partial<Record<string, string>> = {
  engwebp: "https://www.bible.com/bible/206",
  BULG: "https://www.bible.com/bg/bible/1443",
  fraLSG: "https://www.bible.com/bible/93",
  russyn: "https://www.bible.com/ru/bible/167",
  turytc: "https://www.bible.com/tr/bible/3844",
};

export function offlineDailyVerse(date: string, language: Language, dailyPassage?: string) {
  const edition = editions[language];
  // Interpret the already-selected local calendar date as a day index, independent of DST.
  const day = Date.parse(date + "T00:00:00Z") / dayMs;
  if (!edition || !Number.isInteger(day)) return null;
  const count = data.rotation.length;
  const passageId = dailyPassage && Object.hasOwn(edition.verses, dailyPassage)
    ? dailyPassage : data.rotation[((day % count) + count) % count];
  const [book, chapter, number] = passageId.split(".");
  const text = edition.verses[passageId];
  if (!text) return null;
  const bookName = edition.books[book];
  const reference = `${bookName} ${chapter}:${number}`;
  const gateway = (lookup: string) => `https://www.biblegateway.com/passage/?search=${encodeURIComponent(lookup)}&version=BULG`;
  const sourceChapterUrl = edition.id === "BULG"
    ? gateway(`${bookName} ${chapter}`)
    : `https://ebible.org/${edition.id}/${book}${chapter.padStart(2, "0")}.htm`;
  const verseUrl = edition.id === "BULG" ? gateway(reference) : `${sourceChapterUrl}#V${number}`;
  const reader = bibleReaders[edition.id];
  // The comparison page provides chapter links when no reader edition is mapped.
  const bibleUrl = reader ? `${reader}/${passageId}` : `https://www.bible.com/bible/compare/${passageId}`;
  const chapterUrl = reader ? `${reader}/${book}.${chapter}${edition.id === "fraLSG" ? ".LSG" : ""}`
    : edition.id === "heb" ? sourceChapterUrl : bibleUrl;
  const licenseUrl = edition.license ? `https://creativecommons.org/licenses/${edition.license}/4.0/` : undefined;
  const attribution = [edition.title, edition.copyright].filter(Boolean).join(" · ");
  return { passageId, languageTag: language, text, reference, attribution, sourceUrl: edition.source, licenseUrl, chapterUrl, verseUrl, bibleUrl };
}

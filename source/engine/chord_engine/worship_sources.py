"""Bounded public-title discovery; never downloads or caches website lyric bodies.

Worship Leader uses explicit authorized OpenSong collection import instead. Index
adapters retain exact page URLs, not a generic link masquerading as a result.
"""
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit, parse_qs, urlencode
from urllib.robotparser import RobotFileParser
import hashlib
import xml.etree.ElementTree as ET
from html import escape
import re
import time
import unicodedata
import urllib.error
import urllib.request

SOURCES = {
    "worshipleader": ("Worship Leader", "https://worshipleaderapp.com/en/download-song-database-opensong-openlp-and-quelea/"),
    "propovedi": ("Християнски песни", "https://pesni.propovedi.org/1-50/"),
    "tekstove": ("Текстове на песни", "https://tekstovenapesni.wordpress.com/home/"),
    "duhovni": ("Духовни песни", "https://duhovnipesni.org/index.php"),
    "trinity": ("Trinity songbook", "https://trinity-bg.org/songbook/index.html"),
    "holytrinity": ("Света Троица", "https://media.holy-trinity.eu/pesni/"),
    "vitania": ("Витания Казанлък", "https://vitaniakazanlak.blogspot.com/"),
}
AGENT = "HearthKeys/0.1.0 (https://ko-fi.com/stefandimov1008)"


class Links(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links, self.row, self.current = [], "", None

    def handle_starttag(self, tag, attrs):
        if tag in ("br", "p", "tr", "li"):
            self.row = ""
        if tag == "a":
            self.current = [dict(attrs).get("href", ""), "", self.row]

    def handle_data(self, data):
        self.row = (self.row + data)[-1000:]
        if self.current is not None:
            self.current[1] += data

    def handle_endtag(self, tag):
        if tag == "a" and self.current is not None:
            self.links.append(self.current)
            self.current = None


def parse_index(source, html):
    parser = Links()
    parser.feed(html)
    label, base = SOURCES[source]
    found = {}
    for href, title, preceding in parser.links:
        url = urljoin(base, href)
        parts = urlsplit(url)
        if parts.hostname != urlsplit(base).hostname or parts.scheme not in ("http", "https"):
            continue
        title = " ".join(title.split())
        song_number = ""
        if source == "propovedi":
            match = re.fullmatch(r"/(\d{3,4})/", parts.path)
            if not match: continue
            song_number = match[1].lstrip("0")
            title = re.sub(r"^\d+\s*[.\-]?\s*", "", title)
        elif source == "tekstove" or source == "vitania":
            pattern = r"/\d{4}/\d{2}/\d{2}/.+" if source == "tekstove" else r"/\d{4}/\d{2}/[^/]+\.html"
            if not re.fullmatch(pattern, parts.path) or parts.fragment: continue
        elif source == "duhovni":
            if not parts.path.endswith("/pesen.php") or not parse_qs(parts.query).get("id"): continue
            song_number = parse_qs(parts.query)["id"][0]
        elif source == "holytrinity":
            song_number = parse_qs(parts.query).get("id", [""])[0]
            if not song_number.isdigit(): continue
            title = re.sub(r"^\d+\.\s*", "", title)
        elif source == "trinity":
            if not re.fullmatch(r"/songbook/\d+\.html", parts.path) or not title.isdigit(): continue
            song_number = title
            title = re.sub(r"\s*\([A-G][^)]*\)\s*-?\s*$", "", preceding).strip(" -\r\n")
        if not title or title.isdigit() or len(title) > 240:
            continue
        # Menus may repeat a title with a whole lyric excerpt later. Keep title only.
        if url in found: continue
        cid = source + ":" + hashlib.sha256(url.encode()).hexdigest()[:24]
        found[url] = dict(id=cid, title=title, artist="", songwriter="", language="bg", duration=0,
                          provider=label, sourceId=source, sourceUrl=url, songNumber=song_number,
                          version="unspecified", rights="metadata-link-only", canExport=False,
                          plain="", lines=[], available=False, linkOnly=True)
    return list(found.values())[:5000]


def read_url(url, encoding="utf-8", limit=1_000_000):
    request = urllib.request.Request(url, headers={"User-Agent": AGENT})
    with urllib.request.urlopen(request, timeout=3) as response:
        data = response.read(limit + 1)
        if len(data) > limit: raise ValueError("Source index exceeds size limit")
        return data.decode(encoding)


def fetch_index(source, query=""):
    """Two bounded requests at most; a denied robots policy is never bypassed."""
    base = SOURCES[source][1]
    if source == "vitania":
        base = urljoin(base, "feeds/posts/summary?") + "?" + urlencode({"q": query, "max-results": 20})
    robots = urljoin(base, "/robots.txt")
    try:
        rules = read_url(robots, limit=250_000)
        if not rules.lstrip().startswith("<"):
            policy = RobotFileParser()
            policy.parse(rules.splitlines())
            if not policy.can_fetch("HearthKeys", base):
                return source, [], "robots-disallowed"
            delay = policy.crawl_delay("HearthKeys") or policy.crawl_delay("*") or 0
            if delay > 10: return source, [], "crawl-delay"
            if delay: time.sleep(delay)
            # Cached indexes avoid repeated requests. No song pages are crawled.
    except urllib.error.HTTPError as error:
        if error.code not in (404, 410): return source, [], "unavailable"
    except (OSError, ValueError):
        return source, [], "unavailable"
    try:
        html = read_url(base, "cp1251" if source == "trinity" else "utf-8")
        if source == "vitania":
            if "<!DOCTYPE" in html.upper() or "<!ENTITY" in html.upper(): raise ValueError("Unexpected feed entities")
            root = ET.fromstring(html)
            ns = {"a": "http://www.w3.org/2005/Atom"}
            html = "".join('<a href="' + escape(link.get("href", ""), quote=True) + '">' + escape(entry.findtext("a:title", "", ns)) + '</a>'
                           for entry in root.findall("a:entry", ns) for link in entry.findall("a:link", ns) if link.get("rel") == "alternate")
        rows = parse_index(source, html)
        return source, rows, "ready" if rows or source == "vitania" else "index-changed"
    except (OSError, ValueError):
        return source, [], "unavailable"


def fetch_indexes(sources, query=""):
    with ThreadPoolExecutor(max_workers=3) as pool:
        return list(pool.map(lambda source: fetch_index(source, query), sources))


def title_key(value):
    value = unicodedata.normalize("NFC", value).casefold().replace("i\u0307", "i")
    return " ".join(re.findall(r"[^\W_]+", value))


def matches_title(candidate, title):
    # No fuzzy/transliteration auto-selection: composition titles are ambiguous.
    a, b = title_key(candidate["title"]), title_key(title)
    if a == b: return True
    words = set(a.split())
    return len(words) >= 2 and len(words & set(b.split())) / max(1, len(words | set(b.split()))) >= .75

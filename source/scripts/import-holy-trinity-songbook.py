"""Import the publisher's chorded Holy Trinity collection into Sion Keys.

Run with Python 3.12 and --authorized after confirming local-use permission.
The official combined songbook is fetched once; no individual pages are crawled.
"""
import argparse
from html import unescape
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from urllib.robotparser import RobotFileParser
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine"))
from chord_engine import song_sheet

ORIGIN = "https://media.holy-trinity.eu"
BOOK = ORIGIN + "/pesni/index.php?id=all"
USER_AGENT = "Sion Keys"


def read(url, limit):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=15) as response:
        if not response.url.startswith(ORIGIN + "/"):
            raise ValueError("Unexpected source redirect")
        data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError("Songbook download exceeds size limit")
    return data.decode("utf-8-sig")


def plain(fragment):
    return unescape(re.sub(r"<[^>]+>", "", fragment)).replace("\u00a0", " ")


def songs(html):
    headings = list(re.finditer(r"<h1\b[^>]*>\s*(\d+)\.\s*(.*?)</h1>", html, re.I | re.S))
    for index, heading in enumerate(headings):
        number, title = heading[1], plain(heading[2]).strip()
        end = headings[index + 1].start() if index + 1 < len(headings) else len(html)
        rows = []
        for table_row in re.findall(r"<tr\b[^>]*>(.*?)</tr>", html[heading.end():end], re.I | re.S):
            stanza = re.search(r"<pre\b[^>]*>(.*?)</pre>", table_row, re.I | re.S)
            if not stanza:
                continue
            marker = re.search(r'<div\b[^>]*class=["\'](?:tag|lyrics2)["\'][^>]*>(.*?)</div>', table_row, re.I | re.S)
            label = plain(marker[1]).strip() if marker else ""
            if label:
                rows.append("[" + label + "]")
            markup = re.sub(r"<br\s*/?>", "\n", stanza[1], flags=re.I)
            for line in markup.splitlines():
                value = plain(line)
                if not value.strip():
                    continue
                # The publisher marks chord columns with bold spans in PRE.
                # Only rows consisting entirely of recognizable chords qualify.
                if re.search(r"<b\b", line, re.I) and all(song_sheet.CHORD.fullmatch(token) for token in value.split()):
                    rows.append("." + value)
                else:
                    rows.append(" " + value)
            rows.append("")
        if title and any(row.startswith(".") for row in rows):
            yield number, title, rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--authorized", action="store_true", help="Confirm local-use permission for the collection")
    args = parser.parse_args()
    if not args.authorized:
        parser.error("--authorized is required")
    policy = RobotFileParser()
    policy.parse(read(ORIGIN + "/robots.txt", 250_000).splitlines())
    if not policy.can_fetch(USER_AGENT, BOOK):
        raise RuntimeError("The publisher's robots policy disallows fetching the collection")
    time.sleep(policy.crawl_delay(USER_AGENT) or policy.crawl_delay("*") or 0)
    entries = list(songs(read(BOOK, 2_000_000)))
    if not entries:
        raise RuntimeError("No annotated songs were found. Check the publisher's format.")
    db = Path(os.environ["LOCALAPPDATA"]) / "com.chordai.learn" / "lyrics.sqlite3"
    engine = ROOT / "resources" / "chord-engine" / "chord-engine.exe"
    with tempfile.TemporaryDirectory() as folder:
        archive = Path(folder) / "holy-trinity.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
            for number, title, rows in entries:
                song = ET.Element("song")
                for key, value in {"title": title, "number": number, "language": "bg",
                                   "source_url": ORIGIN + "/pesni/?id=" + number, "lyrics": "\n".join(rows)}.items():
                    ET.SubElement(song, key).text = value
                output.writestr(number + ".xml", ET.tostring(song, encoding="utf-8"))
        request = dict(action="import", song="songbook:holytrinity", metadata={"title": "", "language": "bg"},
                       path=str(archive), sourceId="holytrinity", authorized=True)
        proc = subprocess.run([str(engine), "lyrics", "--db", str(db)], input=json.dumps(request),
                              capture_output=True, encoding="utf-8", timeout=25, check=True)
        result = json.loads(proc.stdout.splitlines()[-1])
        if result.get("error"):
            raise RuntimeError(result["error"])
        print("Imported", result["imported"], "Holy Trinity song charts.")


if __name__ == "__main__":
    main()

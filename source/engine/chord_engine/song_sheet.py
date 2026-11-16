"""Read chord positions without assigning playback timestamps."""
import re

CHORD = re.compile(
    r"(?:[A-G][#b♯♭]?(?:(?:maj|min|dim|aug|sus|add|alt|m|M|ø|°|[+\-0-9#b♯♭(),:])+)?(?:/[A-G][#b♯♭]?)?|N\.?C\.?)\Z"
)
SECTION = re.compile(r"\[([^\[\]]+)\]\s*\Z")
STRUCTURES = {"maj": "", "min": "m", "dom7": "7", "maj7": "maj7", "min7": "m7",
              "minMaj7": "mMaj7", "dim7": "dim7", "hdim7": "m7(b5)", "aug": "aug",
              "dim": "dim", "sus2": "sus2", "sus4": "sus4", "maj6": "6", "min6": "m6",
              "dom9": "9", "dom11": "11", "dom13": "13", "min9": "m9", "maj9": "maj9"}


def row(text="", chords=None, section=False):
    return {"text": text, "chords": chords or [], **({"section": True} if section else {})}


def section_order(rows, order):
    """Expand a declared presentation order only when all section names resolve."""
    sections = {}
    intro = []
    current = intro
    for item in rows:
        if item.get("section"):
            current = []
            name = item["text"].strip("[]").casefold()
            if name in sections:
                return rows
            sections[name] = current
        current.append(item)
    keys = order.casefold().split()
    if not keys or any(key not in sections for key in keys):
        return rows
    return intro + [item for key in keys for item in sections[key]]


def opensong(text, order=""):
    rows, pending = [], []
    for line in text.splitlines():
        if line.startswith("."):
            if pending:
                rows.append(row(chords=pending))
            pending = [{"at": m.start(), "label": m[0]} for m in re.finditer(r"\S+", line[1:].expandtabs(8))
                       if CHORD.fullmatch(m[0])]
        elif SECTION.fullmatch(line):
            if pending:
                rows.append(row(chords=pending))
            pending = []
            rows.append(row(line, section=True))
        else:
            words = line[1:] if line.startswith(" ") else line
            rows.append(row(words.expandtabs(8), pending))
            pending = []
    if pending:
        rows.append(row(chords=pending))
    return section_order(rows, order)


def openlyrics(lyrics, order=""):
    rows = []
    for verse in lyrics:
        if verse.tag not in ("verse", "instrument"):
            continue
        rows.append(row("[" + verse.get("name", "Verse") + "]", section=True))
        for lines in verse.findall("lines"):
            text, chords = "", []

            def flush():
                nonlocal text, chords
                rows.append(row(text, chords))
                text, chords = "", []

            def walk(node):
                nonlocal text
                text += node.text or ""
                for child in node:
                    if child.tag == "br":
                        flush()
                    elif child.tag == "line":
                        if text.strip() or chords:
                            flush()
                        text = ""
                        walk(child)
                        flush()
                    else:
                        if child.tag == "chord":
                            root = child.get("root", "")
                            structure = child.get("structure", "")
                            bass = child.get("bass", "")
                            # Keep interval spellings when a structure has no shorthand.
                            suffix = STRUCTURES.get(structure, f"({structure})" if structure else "")
                            label = child.get("name") or (root + suffix + ("/" + bass if bass else "") if root else "")
                            if label and (CHORD.fullmatch(label) or re.fullmatch(r"[A-G][#b♯♭]?\([A-Za-z0-9+#♯♭-]+\)(?:/[A-G][#b♯♭]?)?", label)):
                                chords.append({"at": len(text), "label": label})
                        walk(child)
                    tail = child.tail or ""
                    if child.tag == "line" and not tail.strip():
                        continue
                    text += tail
            walk(lines)
            if text.strip() or chords or not list(lines):
                flush()
        rows.append(row())
    return section_order(rows, order)


def chordpro(text):
    rows, metadata = [], {}
    chorus_start = None
    chorus = []
    labels = {"soc": "Chorus", "sov": "Verse", "sob": "Bridge",
              "start_of_chorus": "Chorus", "start_of_verse": "Verse", "start_of_bridge": "Bridge"}
    for line in text.splitlines():
        if line.startswith("#"):
            continue
        directive = re.fullmatch(r"\s*\{([\w_]+)(?:\s*:\s*(.*?))?\}\s*", line)
        if directive:
            name, value = directive[1].lower(), directive[2] or ""
            name = {"t": "title", "st": "subtitle", "c": "comment"}.get(name, name)
            if name in ("title", "subtitle", "artist", "composer", "lyricist", "copyright", "key", "language"):
                metadata[name] = value
            elif name in labels:
                heading = value.removeprefix('label="').removesuffix('"') or labels[name]
                if labels[name] == "Chorus":
                    chorus_start = len(rows)
                rows.append(row("[" + heading + "]", section=True))
            elif name in ("eoc", "end_of_chorus") and chorus_start is not None:
                chorus = rows[chorus_start:]
                chorus_start = None
            elif name == "chorus" and chorus:
                rows.extend([row("[" + value + "]", section=True), *chorus[1:]] if value else chorus)
            elif name == "comment" and value:
                rows.append(row("[" + value + "]", section=True))
            continue
        words, chords, cursor = "", [], 0
        for marker in re.finditer(r"\[([^\[\]]+)\]", line.expandtabs(8)):
            line = line.expandtabs(8)
            label = marker[1]
            if not CHORD.fullmatch(label):
                continue
            words += line[cursor:marker.start()]
            chords.append({"at": len(words), "label": label})
            cursor = marker.end()
        rows.append(row(words + line.expandtabs(8)[cursor:], chords))
    return rows, metadata

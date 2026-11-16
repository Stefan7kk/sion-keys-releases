# Third-party licenses and Windows redistribution review

Reviewed 2026-11-11. The root MIT license covers Sion Keys application code
owned by Stefan Dimov. Third-party code, binaries, data, and branding require
their own notices or permissions. This is a release review of the current local
build and its inputs.

## Confirmed findings

- **FFmpeg and FFprobe.** The local executables report LGPLv3-or-later.
  FFmpeg identifies itself as `n9.0.2-48-gd4070a14ce-20261108`.
  Its configure flags include `--enable-version3` and omit both
  `--enable-gpl` and `--enable-nonfree`. Sion Keys runs the executables
  as separate processes and supports a replacement via `CHORD_FFMPEG_DIR`.
  The bundle includes the LGPLv3 text. Before redistribution, provide the
  applicable GNU license texts, the corresponding source and build materials
  for the exact executables and applicable linked components, and instructions
  for using replacements. The local provenance note identifies the build
  family. Both executables were matched byte-for-byte to the immutable
  BtbN release archive; the archive and binary hashes are recorded in
  [FFmpeg provenance](resources/ffmpeg/REDISTRIBUTION.md). The exact archive
  does not substitute for the complete corresponding source and notices.
  [FFmpeg guidance](https://ffmpeg.org/legal.html) ·
  [FFmpeg source commit](https://github.com/FFmpeg/FFmpeg/commit/d4070a14ce) ·
  [Build project](https://github.com/FFmpeg-Builds/FFmpeg-Builds)
- **yt-dlp and Mutagen.** The pinned yt-dlp Python package is Unlicense.
  The installed yt-dlp-ejs metadata lists Unlicense, MIT and ISC. The
  older `yt-dlp[default]` dependency set brought in Mutagen 1.48.1
  (GPL-2.0-or-later). Current engine requirements list the other dependencies
  explicitly and PyInstaller excludes Mutagen. The rebuilt archive is
  verified free of its modules. The older Windows setup executable was
  not rebuilt. PyInstaller 6.16.0's exception covers its bootloader and
  does not waive dependency terms.
  [yt-dlp licensing and dependencies](https://github.com/yt-dlp/yt-dlp#license) ·
  [Mutagen license](https://github.com/quodlibet/mutagen/blob/main/COPYING) ·
  [PyInstaller exception](https://pyinstaller.org/en/v6.16.0/license.html)
- **Python engine and native libraries.** Local package metadata identifies
  NumPy and SciPy as BSD-licensed, librosa as ISC, Bottleneck as simplified
  BSD, and SoundFile as BSD-3-Clause. The packaged SoundFile payload includes
  `libsndfile_x64.dll` with an LGPL 2.1 license copy. The engine also
  contains the SoXR extension, whose installed package declares
  LGPL-2.1-or-later. The frozen archive includes certifi (MPL-2.0) and tqdm
  (installed metadata lists MPL-2.0 AND MIT). The bundled NumPy notice
  identifies OpenBLAS, LAPACK and GCC runtime components under their own
  terms, including GPL-3.0 with the GCC Runtime Library Exception. Confirm
  which components are present in each native binary. Inventory the final frozen
  archive and native DLLs, including CPython, OpenSSL, the MSVC runtime,
  NumPy/SciPy native dependencies and wheel-vendored libraries. Confirm
  their exact versions, license texts, source availability and replacement
  requirements where applicable. The development environment contains extra
  research packages and is not a reliable installer inventory.
- **Node.js 22.14.0.** Verified using the bundled executable. Node's own
  license is MIT, and its upstream `LICENSE` contains separate notices for
  embedded dependencies. The bundle includes the full notice file. Verify the
  exact binary against upstream checksums for release.
  [Node.js release files](https://nodejs.org/dist/v22.14.0/)
- **npm and Cargo.** React and React DOM 19.3.1 declare MIT. Tauri's JS API
  and core Rust crate offer MIT or Apache-2.0. The npm lockfile also lists
  Lightning CSS (MPL-2.0) and caniuse-lite (CC-BY-4.0), both through build
  dependencies. Windows-filtered Cargo metadata includes MPL-2.0 crates such
  as cssparser, selectors and option-ext. The reviewed npm and Windows Cargo
  metadata contained no GPL or non-commercial declarations. Map build-time
  versus shipped code for the final build and ship applicable attribution,
  license and MPL source information. Lockfile metadata is a starting
  inventory, especially for vendored code and generated frontend output.

## ChordFormer and research data

The runtime integration looks for a separate local checkout under
`work/benchmark/chordformer`. That checkout points to
[ChordFormer](https://github.com/mwaseemrandhawa/ChordFormer)
(commit `3da11c078c802b3f5a2ff0f6f8ec184a41537844`), which credits
[the upstream ISMIR implementation](https://github.com/music-x-lab/ISMIR2019-Large-Vocabulary-Chord-Recognition).
The upstream repository identifies its own MIT license. The local ChordFormer
checkout did not contain a license granting redistribution for the adapted code
or five checkpoint files. The audit did not establish a non-commercial grant
or a broader grant for those files. Keep the checkout, checkpoints, datasets,
and benchmark audio out of the public repository and installer until their
individual terms are confirmed. No ChordFormer checkpoint or PyTorch runtime
was found in the current installer resource tree. Without the local research
runtime, Sion Keys uses its built-in chord detector.

## CREMA 0.2.0 pretrained weights

On 2026-11-12, CREMA maintainer Brian McFee confirmed that the project's
BSD-2-Clause license covers the pretrained weights in response to a commercial
redistribution inquiry. This resolves the upstream grant for the published
checkpoint. The source recording datasets retain their own terms.
[Maintainer confirmation](https://github.com/bmcfee/crema/issues/42#issuecomment-6825975506) ·
[BSD-2-Clause license](https://github.com/bmcfee/crema/blob/051c91697fd16856a0a1019cc06ee1f11fb52c5f/LICENSE.md)

The evaluated TuneForge ONNX artifact derives from the CREMA 0.2.0 H5 checkpoint
(SHA-256 `08b80e5b648e743c89284e9bc0b12b993dad1129157a75e0de70e076b0b8a235`).
The pinned conversion carries the same BSD notice. A future distribution must
include the BSD copyright, conditions and disclaimer, credit Brian McFee,
and include the applicable notices for the conversion code and ONNX Runtime.
CREMA currently runs only as a Windows source experiment. Its model and runtime
are outside the installer resource tree.
[Pinned conversion manifest](https://huggingface.co/grazzolini/tuneforge-models/blob/895b249c4ccabaedc0770b12935c2b7b2f60e145/crema/manifest.json)

## Branding and release decision

Branding includes the Sion Keys name and wordmark, About logo, Windows icons
in `src-tauri/icons/`, and the banner, sidebar, and story art in
`src/assets/`. Confirm the designer's permissions for public source and
binary redistribution. Once rights are confirmed, use a separate branding
notice identifying the exact assets and permitted uses, including how forks
should distinguish their builds. The notice should apply to those brand assets
and leave the MIT grant for the source code intact.

The old installer predates the Mutagen exclusion. A public installer still
needs the applicable LGPL corresponding source and notices and a final
inventory of the actual build.
Review the NSIS output and any WebView2 bootstrapper or runtime actually
distributed for their applicable terms. This document records findings and
does not substitute for the required third-party notices or source materials.

## Lyrics providers — review 2026-11-11

The MIT grant for Sion Keys does not grant rights to song lyrics. No lyric
collection is bundled. Online text is kept in memory for viewing, not written
to History, the SQLite provider cache, or exports. Copy is disabled for provider
text. User-written editor text remains in its existing separate local storage.
User-initiated imports require confirmation of permission for local storage;
that confirmation is not a redistribution grant. Imported text also has export
disabled. No report is sent to a provider or administrator.

- **LRCLIB — automatic API lookup.** [Official API documentation](https://lrclib.net/docs.txt)
  permits anonymous application access and requires client identification and
  observance of Retry-After. Requests identify Sion Keys, run sequentially,
  have bounded responses/timeouts, and persist a retry deadline. Only title
  and available artist metadata are sent, never file paths or audio. The
  reviewed API documentation did not supply a blanket copyright license for
  each returned lyric. Store IDs, attribution, metadata, selections and local
  rejections only; refresh text online. No publishing/flagging API is called.
  LRCLIB supplies no language label: unknown language is shown honestly, and
  language-specific automatic matches require known language metadata.
- **Worship Leader — searchable local songbooks.** The [official exports](https://worshipleaderapp.com/en/download-song-database-opensong-openlp-and-quelea/) include OpenSong OSB collections for Bulgarian, Turkish, and English. Sion Keys can read these ZIP-based files when the user explicitly imports them and confirms permission to store the contents locally. The [copyright FAQ](https://worshipleaderapp.com/en/faq/) does not establish a blanket license for the collections. No collection is bundled or fetched automatically. Native OpenLP/Quelea databases and direct RAR/7z import are unsupported.
- **Bulgarian title discovery.** The adapters read public title metadata and link to individual pages for [Християнски песни](https://pesni.propovedi.org/1-50/), [Текстове на християнски песни](https://tekstovenapesni.wordpress.com/home/), [Духовни песни](https://duhovnipesni.org/index.php), [Trinity](https://trinity-bg.org/songbook/index.html), [Света Троица](https://media.holy-trinity.eu/pesni/), and [Витания Казанлък](https://vitaniakazanlak.blogspot.com/). The last uses the Blogger summary feed and sends the song title as the search query. Adapters store bounded title/link metadata in the existing SQLite cache. No permission for automatic lyric display, caching, or redistribution was established for these sites. Existing local import supports authorized OpenSong/OpenLyrics XML, text, LRC and ZIP files with source attribution.
- **Version grouping and manual line timing.** Grouping compares available lyric text in memory. Manual line timing stores only user-entered timestamps keyed to the song and lyric revision. Provider text remains subject to the existing copy/export safeguards.

The older FreeHymns fallback inferred permission from missing copyright words.
That is insufficient evidence and it is no longer used. Add automatic providers
only after verifying their supported interface and applicable content rights.
SQLite is supplied by Python's standard library; this change adds no new npm,
Cargo or Python package dependency. Existing installer/model/branding concerns
above remain unresolved. No public release is authorized by this review.
## Offline daily Scripture

The Sion Keys MIT license covers its own code. The Scripture excerpts in
`src/lib/offline-scripture.json` retain the terms of their respective editions.
The file records each source notice and the original VPL text or USFX archive SHA-256 where applicable.
Only verse text is bundled. Copy and Share include the edition credit, source,
applicable license, and a link to the verse.

- **Public domain per the publisher's notices:** [World English Bible Protestant](https://ebible.org/engwebp/copyright.htm),
  [Van Dyck](https://ebible.org/arb-vd/copyright.htm), [Luther 1912](https://ebible.org/deu1912/copyright.htm),
  [Reina-Valera 1909](https://ebible.org/spaRV1909/copyright.htm), [Louis Segond 1910](https://ebible.org/fraLSG/copyright.htm),
  [Riveduta 1927](https://ebible.org/ita1927/copyright.htm), [Japanese NT 1965](https://ebible.org/jpn1965/copyright.htm),
  [Korean 1910](https://ebible.org/kor/copyright.htm), [World Portuguese Bible](https://ebible.org/porbrbsl/copyright.htm),
  [Biblia Liberă](https://ebible.org/ronbl/copyright.htm), [Russian Synodal](https://ebible.org/russyn/copyright.htm),
  [Hebrew Bible with Franz Delitzsch New Testament](https://ebible.org/heb/copyright.htm),
  [Thai Freedom Bible draft](https://ebible.org/thafb/copyright.htm), [Kulish/Puluj 1905](https://ebible.org/ukr1871/copyright.htm),
  [Vietnamese 1923](https://ebible.org/vie1934/copyright.htm), and [simplified Chinese Union](https://ebible.org/cmn-cu89s/copyright.htm).
  World English Bible is eBible.org's trademark. Its text is preserved as published.
- [Bulgarian BULG](https://www.biblegateway.com/versions/Bulgarian-Bible-BULG/) is
  marked public domain in the United States by its digital source. Its publication
  history and status in other jurisdictions have not been independently established.
- **[CC BY-ND 4.0](https://creativecommons.org/licenses/by-nd/4.0/):**
  [Turkish YTC](https://ebible.org/turytc/copyright.htm), © 2023–2025 İsmail Serinken and eBible.org,
  and [Updated Gdansk](https://ebible.org/polubg/copyright.htm), © 2018 Fundacja Wrota Nadziei.
  Both editions explicitly permit extracts with attribution and unchanged wording and punctuation.
- **[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/):**
  [Bengali IRV](https://ebible.org/benirv/copyright.htm) © 2018, 2019 and
  [Hindi IRV](https://ebible.org/hin2017/copyright.htm) © 2017, 2018, 2019,
  Bridge Connectivity Solutions Pvt. Ltd.
  [Indonesian TSI](https://ebible.org/ind/copyright.htm) © 2021 Yayasan Alkitab Bahasa Kita (Albata)
  and Pioneer Bible Translators International.
  [Biblica® Open Urdu Contemporary Version™](https://ebible.org/urdoucv/copyright.htm)
  © 1999, 2005, 2022, 2024 Biblica, Inc. Biblica is a registered trademark of Biblica, Inc.
  These are unchanged verse excerpts distributed as separately attributed text.

- **Source Serif 4 Regular, 4.005R** is distributed as the upstream Adobe WOFF2 under the SIL Open Font License 1.1. The full notice is shipped in the frontend as `source-serif-4-OFL.txt`. [Upstream release](https://github.com/adobe-fonts/source-serif/releases/tag/4.005R)

### Bulgarian morphology

The offline Bulgarian word-form list is adapted from [UniMorph Bulgarian](https://github.com/unimorph/bul/tree/b60b78dbf1d65867419a260e91ca213dc355c2f3), which credits Wikipedia and is distributed under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). The adapted data at `engine/data/bulgarian-morphology.tsv.gz` is distributed under the same license. It normalizes stress marks, extracts unique Cyrillic word forms, and encodes present indicative person and number as six bits in the order 1sg, 2sg, 3sg, 1pl, 2pl, 3pl. A zero mask means the form has no present indicative tag in the upstream data.

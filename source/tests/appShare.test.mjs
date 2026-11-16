import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { APP_SHARE_COPY, APP_SHARE_TITLE, APP_SHARE_UNAVAILABLE, SHARE_PLATFORMS, appShareTargets, publicShareBase, shareDesign } from "../src/lib/appShare.ts";

const base = publicShareBase("https://example.github.io/sion-keys/");
const catalog = language => JSON.parse(readFileSync(new URL(`../src/lib/locales/${language}.json`, import.meta.url), "utf8"));
const languages = readdirSync(new URL("../src/lib/locales/", import.meta.url))
  .filter(file => /^[a-z]{2}\.json$/.test(file)).map(file => file.slice(0, 2));

test("four themes select the two approved designs and the six platforms use the expected mechanisms", () => {
  assert.deepEqual(["white", "orange", "blue", "purple"].map(shareDesign), ["light", "light", "dark", "dark"]);
  const bg = catalog("bg");
  const { caption, targets } = appShareTargets("bg", "light", bg[APP_SHARE_TITLE], bg[APP_SHARE_COPY], base);
  const page = "https://example.github.io/sion-keys/share/light/bg/";
  assert.deepEqual(Object.keys(targets), SHARE_PLATFORMS);
  assert.equal(base.href, "https://example.github.io/sion-keys/");
  assert.equal(new URL(targets.Facebook).searchParams.toString(), new URLSearchParams({ u: page }).toString());
  assert.equal(new URL(targets.WhatsApp).searchParams.get("text"), caption);
  assert.ok(caption.includes("Открийте Sion Keys!"));
  assert.ok(caption.endsWith(page));
  assert.equal(new URL(targets.X).searchParams.get("text"), bg[APP_SHARE_TITLE]);
  assert.equal(new URL(targets.X).searchParams.get("url"), page);
  assert.equal(new URL(targets.Telegram).searchParams.get("url"), page);
  assert.equal(new URL(targets.Telegram).searchParams.get("text"), `${bg[APP_SHARE_TITLE]}\n\n${bg[APP_SHARE_COPY]}`);
  assert.equal(new URL(targets.Instagram).search, "");
  assert.equal(new URL(targets.TikTok).pathname, "/upload");
});

test("unsafe or unrelated link shapes are rejected and a GitHub release is shared exactly", () => {
  for (const value of [undefined, "", "http://github.com/example/sion-keys", "https://user@github.com/example/sion-keys", "https://github.com:8144/example/sion-keys", "https://github.com/", "https://github.com/example/sion-keys/issues", "https://example.github.io.evil.example/sion-keys", "https://example.github.io/?query=1"]) {
    assert.equal(publicShareBase(value), null, value);
  }
  const result = appShareTargets("en", "light", "Sion Keys", "Description", null);
  assert.equal(result.caption, "");
  assert.ok(Object.values(result.targets).every(target => target === undefined));
  const release = publicShareBase("https://github.com/example/sion-keys/releases/latest");
  const shared = appShareTargets("en", "dark", "Sion Keys", "Description", release);
  assert.equal(new URL(shared.targets.Facebook).searchParams.get("u"), release.href);
});

test("all locale captions and dialog controls are localized and X stays within budget", () => {
  assert.ok(languages.includes("he"));
  for (const language of languages) {
    const strings = catalog(language);
    for (const key of [APP_SHARE_TITLE, APP_SHARE_COPY, APP_SHARE_UNAVAILABLE, "Copy page link", "Love Sion Keys?", "Suggested caption", "Open {platform}", "Save artwork", "Back to sharing", "Copy caption", "Save the artwork and copy the caption, then choose Create in Instagram.", "Copy the caption and open TikTok. To post this photo, use the TikTok mobile app if the website only accepts video.", "Facebook shares the link and its preview. Copy this caption if you want to paste it into your post."]) {
      assert.ok(strings[key], `${language}: ${key}`);
      if (language !== "en") assert.notEqual(strings[key], key);
    }
    const { targets } = appShareTargets(language, "dark", strings[APP_SHARE_TITLE], strings[APP_SHARE_COPY], base);
    assert.ok(Array.from(new URL(targets.X).searchParams.get("text")).length * 2 + 24 <= 280);
  }
});

test("static pages for every locale and design expose localized Open Graph and X metadata", () => {
  const output = mkdtempSync(join(tmpdir(), "sion-share-test-"));
  try {
    const generator = fileURLToPath(new URL("../scripts/build-share-pages.mjs", import.meta.url));
    execFileSync(process.execPath, [generator, output], { env: { ...process.env, VITE_SION_SHARE_URL: base.href } });
    for (const design of ["light", "dark"]) {
      const folder = join(output, "share", design);
      const file = `sion-keys-share-${design}.png`;
      const bytes = readFileSync(join(folder, file));
      assert.deepEqual(bytes, readFileSync(new URL(`../src/assets/${file}`, import.meta.url)));
      for (const language of languages) {
        const page = readFileSync(join(folder, language, "index.html"), "utf8");
        const link = `${base.href}share/${design}/`;
        assert.ok(page.includes(`<html lang="${language}" dir="${["ar", "he", "ur"].includes(language) ? "rtl" : "ltr"}">`));
        assert.ok(page.includes(`property="og:url" content="${link}${language}/"`));
        assert.ok(page.includes(`property="og:image" content="${link}${file}"`));
        assert.ok(page.includes(`name="twitter:image" content="${link}${file}"`));
        assert.ok(page.includes(`property="og:image:width" content="${bytes.readUInt32BE(16)}"`));
        assert.ok(page.includes(`property="og:image:height" content="${bytes.readUInt32BE(20)}"`));
        assert.ok(page.includes(`property="og:title" content="${catalog(language)[APP_SHARE_TITLE]}"`));
      }
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_SHARE_COPY, APP_SHARE_TITLE, publicShareBase, socialPage } from "../src/lib/appShare.ts";
import { languageDirection } from "../src/lib/languages.ts";

const base = publicShareBase(process.env.VITE_SION_SHARE_URL);
const project = fileURLToPath(new URL("../", import.meta.url));
if (!base?.hostname.endsWith(".github.io")) {
  throw new Error("Set VITE_SION_SHARE_URL to the approved GitHub Pages landing page before generating previews.");
}
const output = resolve(project, process.argv[2] || "work/social-share");
const locales = join(project, "src/lib/locales");
const escape = value => value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

for (const design of ["light", "dark"]) {
  const imageFile = `sion-keys-share-${design}.png`;
  const imagePath = join(project, "src/assets", imageFile);
  const imageFolder = join(output, "share", design);
  await mkdir(imageFolder, { recursive: true });
  await copyFile(imagePath, join(imageFolder, imageFile));
  const imageBytes = await readFile(imagePath);
  const width = imageBytes.readUInt32BE(16);
  const height = imageBytes.readUInt32BE(20);
  for (const file of await readdir(locales)) {
    if (!/^[a-z]{2}\.json$/.test(file)) continue;
    const language = file.slice(0, 2);
    const dir = languageDirection(language);
    const catalog = JSON.parse(await readFile(join(locales, file), "utf8"));
    if (!catalog[APP_SHARE_COPY] || !catalog[APP_SHARE_TITLE] || !catalog["Sion Keys promotional artwork"]) {
      throw new Error(`Missing share copy for ${language}`);
    }
    const description = escape(catalog[APP_SHARE_COPY]);
    const title = escape(catalog[APP_SHARE_TITLE]);
    const alt = escape(catalog["Sion Keys promotional artwork"]);
    const pageUrl = socialPage(base, language, design);
    const page = escape(pageUrl);
    const photo = escape(new URL(`../${imageFile}`, pageUrl).href);
    const html = `<!doctype html>
<html lang="${language}" dir="${dir}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="canonical" href="${page}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${page}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:image" content="${photo}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="${width}">
  <meta property="og:image:height" content="${height}">
  <meta property="og:image:alt" content="${alt}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${description}">
  <meta name="twitter:image" content="${photo}">
  <meta name="twitter:image:alt" content="${alt}">
  <style>
    html { background: ${design === "light" ? "#eaf7ff" : "#180e32"}; color: ${design === "light" ? "#102a46" : "#f8efff"}; font: 18px/1.6 system-ui, sans-serif; }
    main { max-width: 46rem; margin: 2rem auto; padding: 0 1rem; }
    h1 { font-family: Georgia, serif; }
    img { display: block; width: 100%; height: auto; border-radius: 12px; }
    a { color: inherit; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <img src="${photo}" width="${width}" height="${height}" alt="${alt}">
    <p>${description}</p>
    <a href="${escape(base.href)}">Sion Keys</a>
  </main>
</body>
</html>
`;
    const folder = join(imageFolder, language);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "index.html"), html);
  }
}

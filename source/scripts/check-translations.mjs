import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const localeDir = path.join(root, "src/lib/locales");
const source = JSON.parse(fs.readFileSync(path.join(localeDir, "en.json"), "utf8"));
const languageSource = fs.readFileSync(path.join(root, "src/lib/languages.ts"), "utf8");
const codes = [...languageSource.matchAll(/^\s{2}(\w+): \[/gm)].map(match => match[1]);
const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
const failures = [];
for (const code of codes) {
  const catalog = JSON.parse(fs.readFileSync(path.join(localeDir, `${code}.json`), "utf8"));
  for (const key of Object.keys(source)) {
    if (typeof catalog[key] !== "string" || !catalog[key].trim()) failures.push(`${code}: missing ${key}`);
    else {
      try { assert.deepEqual(placeholders(catalog[key]), placeholders(key)); }
      catch { failures.push(`${code}: placeholder mismatch ${key}`); }
      if (code !== "en" && key.length > 40 && catalog[key] === key) failures.push(`${code}: untranslated sentence ${key}`);
    }
  }
  for (const key of Object.keys(catalog)) if (!(key in source)) failures.push(`${code}: unknown key ${key}`);
}

const uiFiles = ["App.tsx", "components/ChordDashboard.tsx", "components/LanguagePicker.tsx", "components/Sidebar.tsx", "components/TitleBar.tsx", "components/SettingsPage.tsx", "components/HistoryPage.tsx", "components/AboutPage.tsx", "components/DiagnosticDetails.tsx", "lib/engine.ts", "lib/format.ts", "lib/i18n.ts"];
function checkKey(node, file, ast) {
  if (!node) return;
  if (ts.isStringLiteralLike(node)) {
    if (!(node.text in source)) failures.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: uncatalogued ${node.text}`);
  } else if (ts.isConditionalExpression(node)) {
    checkKey(node.whenTrue, file, ast); checkKey(node.whenFalse, file, ast);
  }
}
for (const file of uiFiles) {
  const ast = ts.createSourceFile(file, fs.readFileSync(path.join(root, "src", file), "utf8"), ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(ast);
      if (name === "t") checkKey(node.arguments[0], file, ast);
      if (name === "translate") checkKey(node.arguments[1], file, ast);
      if (["setUrlHint", "setEditError", "setCacheNotice", "setRevtagStatus"].includes(name) && node.arguments[0]?.text !== "") checkKey(node.arguments[0], file, ast);
    }
    if (ts.isJsxText(node) && /[A-Za-z]{3}/.test(node.text) && !/^(Sion Keys|MP3, WAV, FLAC, M4A, AAC, OGG)$/.test(node.text.trim())) {
      failures.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: literal UI text ${node.text.trim()}`);
    }
    if (ts.isJsxAttribute(node) && ["title", "aria-label", "placeholder"].includes(node.name.getText(ast)) && node.initializer && ts.isStringLiteral(node.initializer) && /[A-Za-z]{3}/.test(node.initializer.text)) {
      failures.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: literal UI attribute ${node.initializer.text}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
assert.equal(failures.length, 0, failures.join("\n"));
console.log(`Translation coverage passed: ${codes.length} languages × ${Object.keys(source).length} messages; placeholders and UI literals checked.`);

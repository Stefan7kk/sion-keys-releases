import assert from "node:assert/strict";
import test from "node:test";
import { readYoutubeFavorites, toggleYoutubeFavorite, youtubeFavoritesKey } from "../src/lib/youtubeFavorites.ts";

const first = { id: "abcdefghi01", title: "First song", channel: "Channel", duration: 192, views: 20 };
const second = { id: "abcdefghi02", title: "Second song", channel: null, duration: null, views: null };

test("favorites save locally, retain order and toggle by YouTube ID", () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  assert.deepEqual(toggleYoutubeFavorite(storage, first), [{ ...first, views: null }]);
  assert.deepEqual(toggleYoutubeFavorite(storage, second).map(video => video.id), [second.id, first.id]);
  assert.deepEqual(readYoutubeFavorites(storage.getItem(youtubeFavoritesKey)).map(video => video.id), [second.id, first.id]);
  assert.deepEqual(toggleYoutubeFavorite(storage, { ...first, title: "New title" }), [second]);
  assert.deepEqual([...data.keys()], [youtubeFavoritesKey]);
});

test("invalid saved metadata cannot produce a broken or duplicate favorite", () => {
  assert.deepEqual(readYoutubeFavorites("{corrupted"), []);
  assert.deepEqual(readYoutubeFavorites('{"title":"wrong format"}'), []);
  const entries = [
    { ...first, duration: -5, previewUrl: "https://example.test/preview" },
    { ...first, title: "Duplicate" }, { ...second, id: "bad/id" }, null, { ...second, title: "" },
  ];
  assert.deepEqual(readYoutubeFavorites(JSON.stringify(entries)), [{ ...first, duration: null, views: null }]);
});

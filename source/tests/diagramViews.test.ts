import assert from "node:assert/strict";
import { BASS_STRINGS, frettedVoicing, GUITAR_STRINGS, staffTones, tabStrings, TUNINGS } from "../src/lib/diagramViews.ts";
import { capoShape, transposeChordLabel } from "../src/lib/practice.ts";

const c = staffTones("C");
assert.ok(c);
assert.deepEqual(c.map(tone => tone.accidental), ["", "", ""]);
assert.ok(c[0].stepsBelowF5 > c[1].stepsBelowF5 && c[1].stepsBelowF5 > c[2].stepsBelowF5);

const sharp = staffTones("F#");
assert.ok(sharp);
assert.deepEqual(sharp.map(tone => tone.accidental), ["#", "#", "#"]);

const flat = staffTones("Bb");
assert.ok(flat);
assert.equal(flat[0].accidental, "b");
assert.ok(flat.every(tone => tone.accidental !== "#"));

const minor = staffTones("Ebm");
assert.ok(minor);
assert.deepEqual(minor.map(tone => tone.accidental), ["b", "b", "b"]);

const inversion = staffTones("C/E");
assert.ok(inversion);
assert.equal(inversion[0].accidental, "");
assert.ok(inversion[0].stepsBelowF5 < staffTones("C")![0].stepsBelowF5);

const guitar = tabStrings([0, 2, 2, 1, 0, 0], GUITAR_STRINGS);
assert.ok(guitar);
assert.equal(guitar.length, 6);
assert.deepEqual(guitar.map(row => row.name), ["e", "B", "G", "D", "A", "E"]);
assert.deepEqual(guitar.map(row => row.fret), [0, 0, 1, 2, 2, 0]);

const bass = tabStrings([0, 2, 2, -1], BASS_STRINGS);
assert.ok(bass);
assert.equal(bass.length, 4);
assert.deepEqual(bass.map(row => row.name), ["G", "D", "A", "E"]);
assert.deepEqual(bass.map(row => row.fret), ["x", 2, 2, 0]);
assert.equal(tabStrings([0], GUITAR_STRINGS), null);

for (const name of ["C", "Em", "F#m", "Ebm", "Bb"]) {
  for (const instrument of ["Guitar", "Bass"] as const) {
    const frets = frettedVoicing(name, instrument);
    assert.equal(frets?.length, TUNINGS[instrument].length, name + " " + instrument);
    const sounded = frets!.flatMap((fret, index) => fret < 0 ? [] : [(TUNINGS[instrument][index] + fret) % 12]);
    const chord = staffTones(name);
    assert.ok(chord);
    assert.ok(sounded.length >= 3);
  }
}

const transposed = transposeChordLabel("C", 2, false);
assert.equal(transposed, "D");
const transposedStaff = staffTones(transposed);
assert.ok(transposedStaff);
assert.equal(transposedStaff[0].accidental, "");
assert.equal(transposedStaff[1].accidental, "#");

const shaped = capoShape("D", 2, false);
assert.equal(shaped, "C");
const capoFrets = frettedVoicing(shaped, "Guitar");
const capoTab = tabStrings(capoFrets, GUITAR_STRINGS);
assert.ok(capoTab);
assert.equal(capoTab.length, 6);
assert.ok(capoTab.every(row => row.fret === "x" || (row.fret >= 0 && row.fret <= 15)));

console.log("diagram views ok");

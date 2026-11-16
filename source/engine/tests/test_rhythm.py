"""Audio-level and section-voting regression tests for meter estimates."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from chord_engine.rhythm import _meter_result, estimate_audio_meter

SR = 22050
HOP = 2048


def fixture(groups, divisions=2, *, bars=24, drums=True, variation=False, syncopated=False, intro=0):
    """Short pitched attacks with an independent bass change at each bar."""
    random = np.random.default_rng(42)
    start = intro + .45
    events = []
    for bar in range(bars):
        beat = .53 * (1 + .10 * np.sin(bar * .7)) if variation else .53
        for pulse in range(groups):
            if drums:
                events.append((start + pulse * beat, 75 if pulse % 2 == 0 else 1200, .9 if pulse == 0 else .32))
            events.append((start + pulse * beat, 110 * 2 ** ((bar % 4) / 12), .55 if pulse == 0 else .16))
            if divisions == 3 or syncopated:
                for i in range(1, divisions):
                    events.append((start + (pulse + i / divisions) * beat, 2100, .21))
        start += beat * groups
    audio = np.zeros(int((start + .25) * SR), dtype=np.float32)
    t = np.arange(int(.14 * SR)) / SR
    for when, hz, amplitude in events:
        index = round(when * SR)
        signal = np.sin(2 * np.pi * hz * t) + .15 * random.normal(size=len(t))
        audio[index:index + len(t)] += amplitude * signal * np.exp(-t * 45)
    harmonic = np.zeros((len(audio) // HOP + 1, 12))
    for bar, start in enumerate(event[0] for event in events if event[2] == .55):
        left = round(start * SR / HOP)
        right = round(events[-1][0] * SR / HOP) + 1
        harmonic[left:right, :] = 0
        harmonic[left:right, bar % 4] = 1
    return audio, harmonic


def measure(audio, harmonic):
    return estimate_audio_meter(audio, SR, harmonic, harmonic, HOP)


class MeterTests(unittest.TestCase):
    def test_simple_meter(self):
        for group in (2, 3, 4):
            with self.subTest(group=group):
                self.assertEqual(measure(*fixture(group)).get("timeSignature"), f"{group}/4")

    def test_compound_meter(self):
        for group, expected in [(2, "6/8"), (4, "12/8")]:
            with self.subTest(group=group):
                self.assertEqual(measure(*fixture(group, 3)).get("timeSignature"), expected)

    def test_no_drums_syncopation_and_moderate_tempo_variation(self):
        self.assertEqual(measure(*fixture(3, drums=False, variation=True)).get("timeSignature"), "3/4")
        self.assertEqual(measure(*fixture(4, syncopated=True, intro=5)).get("timeSignature"), "4/4")

    def test_uncertainty_silence_and_unsupported_meter(self):
        silence = np.zeros(24 * SR, dtype=np.float32)
        harmonic = np.zeros((len(silence) // HOP + 1, 12))
        beat = np.sin(np.arange(2200) * .2) * np.linspace(1, 0, 2200)
        self.assertEqual(measure(silence, harmonic), {})
        random = np.random.default_rng(1)
        for index in np.cumsum(random.integers(SR // 4, SR, size=32)):
            if index + len(beat) < len(silence):
                silence[index:index + len(beat)] = beat
        self.assertEqual(measure(silence, harmonic), {})
        self.assertEqual(measure(*fixture(5)), {})

    def test_unaccented_triplets_do_not_establish_three_four_or_six_eight(self):
        audio = np.zeros(22 * SR, dtype=np.float32)
        t = np.arange(1102) / SR
        click = np.sin(2 * np.pi * 800 * t) * np.exp(-80 * t)
        for at in range(SR // 2, len(audio) - len(click), SR // 5):
            audio[at:at + len(click)] = click
        self.assertEqual(measure(audio, np.zeros((len(audio) // HOP + 1, 12))), {})

    def test_competing_sections(self):
        grid = np.arange(128)
        picks = [(0, 32, "3/4", 2, 1, True, .9), (32, 64, "3/4", 35, 1, True, .9),
                 (64, 96, "4/4", 65, 1, True, .9), (96, 128, "4/4", 97, 1, True, .9)]
        self.assertEqual([change["timeSignature"] for change in _meter_result(picks, grid, .5)["meterChanges"]],
                         ["3/4", "4/4"])
        self.assertEqual(_meter_result(picks[1:3], grid, .5), {})

    def test_cancelled(self):
        audio, harmonic = fixture(3)
        self.assertEqual(estimate_audio_meter(audio, SR, harmonic, harmonic, HOP, lambda: True), {})


if __name__ == "__main__":
    unittest.main()

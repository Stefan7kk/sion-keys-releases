"""Shared DSP constants."""

from __future__ import annotations

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Analysis sample rate and hop (aligned with common CQT practice).
SR = 22050
HOP_LENGTH = 2048  # ~93 ms/frame at 22050 Hz

# Krumhansl–Kessler key profiles (cognitive psychology; not a trained model).
KK_MAJOR = [
    6.35,
    2.23,
    3.48,
    2.33,
    4.38,
    4.09,
    2.52,
    5.19,
    2.39,
    3.66,
    2.29,
    2.88,
]
KK_MINOR = [
    6.33,
    2.68,
    3.52,
    5.38,
    2.60,
    3.53,
    2.54,
    4.75,
    3.98,
    2.69,
    3.34,
    3.17,
]

NO_CHORD = "N.C."

# Fallback beat-grouping estimate when the accents do not establish a bar.
DEFAULT_TIME_SIGNATURE = "4/4"

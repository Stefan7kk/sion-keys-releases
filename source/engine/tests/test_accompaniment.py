"""Regression checks for the optional accompaniment timing cross-check."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from chord_engine.accompaniment import refine_boundaries
from chord_engine.chords import ChordSegment


def chord(start, end, label, kind="chord"):
    return ChordSegment(start, end, label, None, "chordformer_label", kind)


class AccompanimentTests(unittest.TestCase):
    def setUp(self):
        self.full = [chord(0, 1, "C:maj"), chord(1, 2, "G:maj"), chord(2, 3, "N", "no_chord")]

    def test_matching_boundary_preserves_original_result_and_provenance(self):
        split = [chord(0, 1.18, "C:maj"), chord(1.18, 1.9, "G:maj"), chord(1.9, 3, "N", "no_chord")]
        result, shifts = refine_boundaries(self.full, split)
        self.assertEqual(shifts, [[1, 1.09]])
        self.assertEqual(self.full[0].end, 1)
        self.assertEqual(result[0].end, result[1].start)
        self.assertEqual(result[2], self.full[2])
        self.assertEqual([x.label for x in result], [x.label for x in self.full])
        self.assertTrue(all(x.score is None and x.scoreKind == "chordformer_label" for x in result))

    def test_ambiguous_or_faraway_transition_is_ignored(self):
        far = [chord(0, 1.26, "C:maj"), chord(1.26, 3, "G:maj")]
        ambiguous = [chord(0, .9, "C:maj"), chord(.9, .96, "G:maj"),
                     chord(.96, 1.08, "C:maj"), chord(1.08, 3, "G:maj")]
        for split in (far, ambiguous):
            result, shifts = refine_boundaries(self.full, split)
            self.assertEqual(shifts, [])
            self.assertEqual(result, self.full)


if __name__ == "__main__":
    unittest.main()


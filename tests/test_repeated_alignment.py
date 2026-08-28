import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "work"))

import model_align


class RepeatedAlignmentTests(unittest.TestCase):
    def test_regularizes_collapsed_repetition_gaps(self):
        rows = [
            {"start": start, "end": start + 1.8}
            for start in (10.0, 12.2, 17.8, 18.5)
        ]

        adjusted = model_align.regularize_repeated_rows(rows, [10.1], 2.2)
        gaps = [
            adjusted[index + 1]["start"] - adjusted[index]["start"]
            for index in range(len(adjusted) - 1)
        ]

        self.assertTrue(all(2.0 <= gap <= 2.4 for gap in gaps))

    def test_finds_consecutive_repeated_runs_with_decorated_ending(self):
        lines = [
            "verse",
            "부딪혀 나의 bumpa",
            "부딪혀 나의 bumpa",
            "부딪혀 나의 bumpa",
            "부딪혀 나의 bumpa paw paw paw",
            "bridge",
        ]

        runs = model_align.find_consecutive_repeated_runs(lines)

        self.assertEqual(1, len(runs))
        self.assertEqual((1, 4), (runs[0]["start"], runs[0]["end"]))
        self.assertEqual(3, runs[0]["exactRepeats"])

    def test_forces_each_repeated_block_without_moving_unique_anchors(self):
        repeated = "부딪혀 나의 bumpa"
        decorated = f"{repeated} paw paw paw"
        lines = [
            "unique before",
            repeated,
            repeated,
            repeated,
            repeated,
            decorated,
            "unique middle",
            repeated,
            repeated,
            repeated,
            repeated,
            decorated,
            "unique after",
        ]
        starts = [10.0, 12.0, 14.0, 16.0, 18.0, 20.0, 23.0, 25.0, 40.0, 42.0, 43.0, 44.0, 50.0]
        timeline = [
            {
                "id": f"line-{index + 1}",
                "index": index,
                "text": line,
                "start": start,
                "end": start + 1.2,
                "confidence": 0.82,
                "source": "word"
            }
            for index, (line, start) in enumerate(zip(lines, starts))
        ]
        best = {
            "alignmentMethod": "global-anchors",
            "duration": 60.0,
            "timeline": timeline,
            "matchedLines": len(lines),
            "quality": 0.5,
            "chunks": []
        }
        model = SimpleNamespace(feature_extractor=SimpleNamespace(sampling_rate=16000))

        def fake_forced_alignment(audio, sampling_rate, context_lines, window_start, window_end, *_):
            rows = []
            cursor = window_start + 1.0
            for line in context_lines:
                rows.append({
                    "text": line,
                    "start": cursor,
                    "end": cursor + 1.7,
                    "confidence": 0.88,
                    "source": "forced-text",
                    "words": [{
                        "text": line,
                        "start": cursor,
                        "end": cursor + 1.7,
                        "probability": 0.9
                    }]
                })
                cursor += 2.1
            return rows

        with patch("faster_whisper.audio.decode_audio", return_value=[]), patch.object(
            model_align,
            "forced_alignment_window",
            side_effect=fake_forced_alignment
        ):
            aligned, forced_count, chunks = model_align.force_align_repeated_runs(
                "unused.mp3",
                lines,
                best,
                model
            )

        self.assertEqual(10, forced_count)
        self.assertEqual(10, len(chunks))
        self.assertEqual("word", aligned["timeline"][0]["source"])
        self.assertEqual("word", aligned["timeline"][6]["source"])
        self.assertEqual("word", aligned["timeline"][12]["source"])
        self.assertTrue(all(
            aligned["timeline"][index]["source"] == "forced-repeat"
            for index in list(range(1, 6)) + list(range(7, 12))
        ))


if __name__ == "__main__":
    unittest.main()

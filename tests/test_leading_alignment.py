import sys
import unittest
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "work"))

import model_align


class LeadingAlignmentTests(unittest.TestCase):
    def test_candidate_fallback_is_selected_for_window_rescue(self):
        timeline = [
            {
                "index": 0,
                "text": "出来れば世界を僕は塗り変えたい",
                "start": 0.0,
                "end": 13.777,
                "confidence": 0.5,
                "source": "candidate-segment",
            },
            {
                "index": 1,
                "text": "戦争をなくすような大逸れたことじゃない",
                "start": 30.0,
                "end": 34.692,
                "confidence": 0.576,
                "source": "segment",
            },
        ]

        self.assertEqual([(0, 0)], model_align.find_window_rescue_runs(timeline))

    def test_leading_candidate_fallback_is_realigned_before_first_anchor(self):
        lines = [
            "出来れば世界を僕は塗り変えたい",
            "戦争をなくすような大逸れたことじゃない",
        ]
        timeline = [
            {
                "index": 0,
                "text": lines[0],
                "start": 25.258,
                "end": 29.95,
                "confidence": 0.28,
                "source": "estimated",
            },
            {
                "index": 1,
                "text": lines[1],
                "start": 30.0,
                "end": 34.692,
                "confidence": 0.576,
                "source": "segment",
            },
        ]
        best = {
            "alignmentMethod": "segment-sequence+candidate-rescue",
            "duration": 271.906,
            "timeline": timeline,
            "matchedLines": 1,
            "quality": 0.6,
        }
        captured = {}

        def fake_transcribe(audio_path, model_name, prompt, language, model, device, clip_timestamps):
            captured["prompt"] = prompt
            captured["language"] = language
            captured["clip"] = clip_timestamps
            return ([{"start": 19.08, "end": 25.58, "text": prompt, "words": []}], 271.906,
                    "faster-whisper-cuda", 12, model, "cuda")

        local_rows = [
            {
                "index": 0,
                "text": lines[0],
                "start": 19.08,
                "end": 25.58,
                "confidence": 0.96,
                "source": "segment",
            }
        ]
        with patch.object(
            model_align,
            "transcribe_with_faster_whisper",
            side_effect=fake_transcribe,
        ), patch.object(
            model_align,
            "align_lines_to_transcript",
            return_value=(local_rows, 1, "segment-sequence"),
        ):
            aligned, _, _, rescued_count, _ = model_align.rescue_alignment_windows(
                "unused.mp3",
                lines,
                best,
                "turbo",
                object(),
                "cuda",
            )

        self.assertEqual(1, rescued_count)
        self.assertEqual(lines[0], captured["prompt"])
        self.assertEqual("ja", captured["language"])
        self.assertEqual([0.0, 30.45], captured["clip"])
        self.assertAlmostEqual(19.08, aligned["timeline"][0]["start"], places=2)
        self.assertAlmostEqual(25.58, aligned["timeline"][0]["end"], places=2)
        self.assertEqual("window-segment-sequence", aligned["timeline"][0]["source"])


if __name__ == "__main__":
    unittest.main()

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "work"))

import model_align


class TailAlignmentTests(unittest.TestCase):
    def test_expands_low_confidence_run_across_prefix_related_line(self):
        lines = [
            "unique line",
            "넘넘 스윗한 넌 정말 달콤한 걸",
            "넘넘 스윗한 넌",
        ]

        self.assertEqual((1, 2), model_align.expand_prefix_overlap_run(lines, 1, 1))

    def test_trailing_low_confidence_run_uses_remaining_audio(self):
        lines = [
            "strong anchor",
            "tail context",
            "long repeated phrase",
            "short repeated phrase",
        ]
        timeline = [
            {"index": 0, "text": lines[0], "start": 160.0, "end": 163.0, "confidence": 0.95},
            {"index": 1, "text": lines[1], "start": 167.0, "end": 170.5, "confidence": 0.92},
            {"index": 2, "text": lines[2], "start": 169.4, "end": 171.6, "confidence": 0.3},
            {"index": 3, "text": lines[3], "start": 171.7, "end": 172.1, "confidence": 0.6},
        ]
        best = {
            "alignmentMethod": "global-anchors",
            "duration": 186.688,
            "timeline": timeline,
            "matchedLines": 3,
            "quality": 0.5,
        }
        model = SimpleNamespace(feature_extractor=SimpleNamespace(sampling_rate=16000))
        captured = {}

        def fake_forced_alignment(audio, sampling_rate, context_lines, window_start, window_end, *_):
            captured["windowStart"] = window_start
            captured["windowEnd"] = window_end
            starts = [167.0, 171.38, 176.72]
            return [
                {
                    "text": line,
                    "start": start,
                    "end": start + 2.0,
                    "confidence": 0.88,
                    "source": "forced-text",
                    "words": [],
                }
                for line, start in zip(context_lines, starts)
            ]

        with patch("faster_whisper.audio.decode_audio", return_value=[]), patch.object(
            model_align,
            "forced_alignment_window",
            side_effect=fake_forced_alignment,
        ):
            aligned, forced_count, _ = model_align.force_align_low_confidence_windows(
                "unused.mp3",
                lines,
                best,
                model,
            )

        self.assertEqual(2, forced_count)
        self.assertAlmostEqual(186.688, captured["windowEnd"], places=3)
        self.assertAlmostEqual(171.38, aligned["timeline"][2]["start"], places=2)
        self.assertAlmostEqual(176.72, aligned["timeline"][3]["start"], places=2)

    def test_tail_rescue_realigns_both_prefix_related_lines(self):
        lines = [
            "strong anchor",
            "tail context",
            "넘넘 스윗한 넌 정말 달콤한 걸",
            "넘넘 스윗한 넌",
        ]
        timeline = [
            {"index": 0, "text": lines[0], "start": 160.0, "end": 163.0, "confidence": 0.95},
            {"index": 1, "text": lines[1], "start": 167.0, "end": 169.3, "confidence": 0.92},
            {"index": 2, "text": lines[2], "start": 169.4, "end": 171.6, "confidence": 0.3},
            {"index": 3, "text": lines[3], "start": 171.7, "end": 172.1, "confidence": 0.76},
        ]
        best = {
            "alignmentMethod": "global-anchors",
            "duration": 186.688,
            "timeline": timeline,
            "matchedLines": 3,
            "quality": 0.5,
        }
        captured = {}

        def fake_transcribe(audio_path, model_name, prompt, language, model, device, clip_timestamps):
            captured["prompt"] = prompt
            captured["clip"] = clip_timestamps
            return ([{"start": 171.0, "end": 180.0, "text": prompt, "words": []}], 186.688,
                    "faster-whisper-cuda", 8, model, "cuda")

        local_rows = [
            {"index": 0, "text": lines[2], "start": 171.38, "end": 176.7, "confidence": 0.97},
            {"index": 1, "text": lines[3], "start": 176.72, "end": 179.7, "confidence": 0.94},
        ]
        with patch.object(
            model_align,
            "transcribe_with_faster_whisper",
            side_effect=fake_transcribe,
        ), patch.object(
            model_align,
            "align_lines_to_transcript",
            return_value=(local_rows, 2, "global-anchors"),
        ):
            aligned, _, _, rescued_count, _ = model_align.rescue_alignment_windows(
                "unused.mp3",
                lines,
                best,
                "turbo",
                object(),
                "cuda",
            )

        self.assertEqual(2, rescued_count)
        self.assertIn(lines[2], captured["prompt"])
        self.assertIn(lines[3], captured["prompt"])
        self.assertAlmostEqual(186.688, captured["clip"][1], places=3)
        self.assertAlmostEqual(171.38, aligned["timeline"][2]["start"], places=2)
        self.assertAlmostEqual(176.72, aligned["timeline"][3]["start"], places=2)


if __name__ == "__main__":
    unittest.main()

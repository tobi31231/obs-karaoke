import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "work"))

import model_align


def synthetic_chunks(lines, pause_every=4):
    lyric_words, _ = model_align.flatten_lyric_words(lines)
    words = []
    cursor = 0.4
    for index, word in enumerate(lyric_words):
        start = cursor
        end = start + 0.28
        words.append({
            "text": word["text"],
            "start": start,
            "end": end,
            "probability": 0.98
        })
        cursor = end + 0.08
        if (index + 1) % pause_every == 0:
            cursor += 0.52

    return [{
        "start": 0.4,
        "end": cursor,
        "text": " ".join(word["text"] for word in lyric_words),
        "words": words
    }]


class AutoSegmentationTests(unittest.TestCase):
    def assert_preserves_lyrics(self, original, segmented):
        self.assertEqual(
            model_align.normalized_text("".join(original)),
            model_align.normalized_text("".join(segmented))
        )

    def test_keeps_existing_short_lines(self):
        lines = ["오늘도 너를 생각해", "다시 만날 수 있다면", "그때는 말할 수 있을까"]
        result, metadata = model_align.auto_segment_lyrics(lines, synthetic_chunks(lines))

        self.assertEqual(lines, result)
        self.assertFalse(metadata["applied"])

    def test_segments_unbroken_korean_lyrics_using_audio_pauses(self):
        lines = [
            "오늘도 너를 생각해 다시 만날 수 있다면 그때는 말할 수 있을까 "
            "우리 다시 만나는 날에는 웃으며 서로 인사해"
        ]
        result, metadata = model_align.auto_segment_lyrics(lines, synthetic_chunks(lines, pause_every=4))

        self.assertTrue(metadata["applied"])
        self.assertGreater(len(result), 1)
        self.assertGreaterEqual(metadata["audioGuidedBoundaries"], 1)
        self.assert_preserves_lyrics(lines, result)
        self.assertTrue(all(model_align.display_width_units(line) <= 60 for line in result))

    def test_segments_unbroken_english_lyrics(self):
        lines = [
            "Now I am ready to go and I will keep fighting my way through every night "
            "until the morning light finally shows us where we belong"
        ]
        result, metadata = model_align.auto_segment_lyrics(lines, synthetic_chunks(lines, pause_every=5))

        self.assertTrue(metadata["applied"])
        self.assertGreater(len(result), 1)
        self.assert_preserves_lyrics(lines, result)
        self.assertGreaterEqual(
            model_align.display_width_units(result[-1]),
            model_align.AUTO_SEGMENT_MIN_WIDTH
        )

    def test_segments_unbroken_japanese_lyrics(self):
        lines = [
            "時には誰かを知らず知らずのうちに傷つけてしまったり"
            "失ったりして初めて犯した罪を知る戻れないよ昔のようには"
            "煌めいて見えたとしても"
        ]
        result, metadata = model_align.auto_segment_lyrics(lines, synthetic_chunks(lines, pause_every=5))

        self.assertTrue(metadata["applied"])
        self.assertGreater(len(result), 1)
        self.assert_preserves_lyrics(lines, result)
        forbidden_starts = ("は", "が", "を", "に", "へ", "と", "で", "の", "も", "たり", "て", "しても")
        self.assertFalse(any(line.startswith(forbidden_starts) for line in result[1:]))


if __name__ == "__main__":
    unittest.main()

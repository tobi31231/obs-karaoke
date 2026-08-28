import argparse
import difflib
import json
import math
import os
import re
import sys
import tempfile
import unicodedata
from pathlib import Path


_DLL_DIRECTORY_HANDLES = []
_SUDACHI_TOKENIZER = None
_SUDACHI_SPLIT_MODE = None
_SUDACHI_UNAVAILABLE = False

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def respond(payload):
    print(json.dumps(payload, ensure_ascii=False))


def module_available(name):
    try:
        __import__(name)
        return True
    except Exception:
        return False


def check_environment(model_name="turbo"):
    faster = module_available("faster_whisper")
    classic = module_available("whisper")
    local_model = resolve_model_path(model_name)
    respond({
        "ok": (faster or classic) and bool(local_model),
        "engine": "faster-whisper" if faster else ("openai-whisper" if classic else None),
        "model": model_name,
        "localModel": local_model,
        "message": f"{model_name} model is ready." if ((faster or classic) and local_model) else f"{model_name} model package or local model files are not installed."
    })


def app_root():
    return Path(__file__).resolve().parents[1]


def configure_cuda_runtime():
    if sys.platform != "win32":
        return
    runtime_bin = app_root() / "runtime" / "cuda" / "bin"
    if not runtime_bin.exists():
        return
    runtime_path = str(runtime_bin)
    os.environ["PATH"] = runtime_path + os.pathsep + os.environ.get("PATH", "")
    if hasattr(os, "add_dll_directory"):
        _DLL_DIRECTORY_HANDLES.append(os.add_dll_directory(runtime_path))


def resolve_model_path(model_name):
    candidates = [
        app_root() / "models" / f"faster-whisper-{model_name}",
        app_root() / "models" / model_name,
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return None


def read_lyrics(path):
    raw = Path(path).read_bytes()
    text = None

    for encoding in ("utf-8-sig", "utf-8", "cp949", "euc-kr"):
        try:
            decoded = raw.decode(encoding)
        except UnicodeDecodeError:
            continue
        if "\ufffd" not in decoded:
            text = decoded
            break

    if text is None:
        text = raw.decode("utf-8", errors="replace")

    return [line.strip() for line in text.splitlines() if line.strip()]


def is_japanese_char(char):
    code = ord(char)
    return (
        0x3040 <= code <= 0x30FF
        or 0x31F0 <= code <= 0x31FF
        or 0x3400 <= code <= 0x4DBF
        or 0x4E00 <= code <= 0x9FFF
        or 0xF900 <= code <= 0xFAFF
        or 0xFF66 <= code <= 0xFF9F
    )


def is_cjk_ideograph(char):
    code = ord(char)
    return (
        0x3400 <= code <= 0x4DBF
        or 0x4E00 <= code <= 0x9FFF
        or 0xF900 <= code <= 0xFAFF
    )


def contains_japanese(text):
    return any(is_japanese_char(char) for char in str(text))


def to_hiragana(char):
    code = ord(char)
    if 0x30A1 <= code <= 0x30F6:
        return chr(code - 0x60)
    return char


def detect_language_hint(lines):
    joined = unicodedata.normalize("NFKC", "".join(lines)).lower()
    hangul = len(re.findall(r"[가-힣]", joined))
    latin = len(re.findall(r"[a-z]", joined))
    kana = len(re.findall(r"[぀-ヿ]", joined))
    japanese = sum(1 for char in joined if is_japanese_char(char))
    language_chars = hangul + latin + japanese

    if hangul >= 8 and hangul / max(1, language_chars) >= 0.25:
        return "ko"
    if kana >= 4 and japanese / max(1, language_chars) >= 0.25:
        return "ja"
    return None


def has_hangul_lyrics(lines):
    return len(re.findall(r"[가-힣]", "".join(lines))) >= 4


def normalize_with_map(text):
    chars = []
    mapping = []
    for index, source_char in enumerate(str(text)):
        for char in unicodedata.normalize("NFKC", source_char).lower():
            char = to_hiragana(char)
            if char in "ゝゞヽヾ" and chars:
                chars.append(chars[-1])
                mapping.append(index)
            elif char.isalnum() or char == "ー":
                chars.append(char)
                mapping.append(index)
    return "".join(chars), mapping


def get_sudachi_tokenizer():
    global _SUDACHI_TOKENIZER, _SUDACHI_SPLIT_MODE, _SUDACHI_UNAVAILABLE
    if _SUDACHI_TOKENIZER is not None:
        return _SUDACHI_TOKENIZER, _SUDACHI_SPLIT_MODE
    if _SUDACHI_UNAVAILABLE:
        return None, None

    try:
        from sudachipy import Dictionary, SplitMode

        _SUDACHI_TOKENIZER = Dictionary().create()
        _SUDACHI_SPLIT_MODE = SplitMode.C
        return _SUDACHI_TOKENIZER, _SUDACHI_SPLIT_MODE
    except Exception:
        _SUDACHI_UNAVAILABLE = True
        return None, None


def japanese_morphemes(text):
    tokenizer, split_mode = get_sudachi_tokenizer()
    if tokenizer is None or not contains_japanese(text):
        return []

    result = []
    for morpheme in tokenizer.tokenize(str(text), split_mode):
        surface = str(morpheme.surface())
        normalized = normalized_text(surface)
        if not normalized:
            continue
        reading = normalized_text(morpheme.reading_form()) if contains_japanese(surface) else normalized
        if not reading or reading == "きごう":
            reading = normalized
        result.append({
            "surface": surface,
            "reading": reading,
            "partOfSpeech": tuple(str(part) for part in morpheme.part_of_speech()),
            "start": int(morpheme.begin()),
            "end": int(morpheme.end())
        })
    return result


def mora_count(reading):
    normalized = normalized_text(reading)
    if not normalized:
        return 0.0

    small_kana = set("ぁぃぅぇぉゃゅょゎゕゖ")
    count = 0.0
    for char in normalized:
        if char in small_kana:
            continue
        count += 1.0
    return count


def japanese_reading_text(text):
    morphemes = japanese_morphemes(text)
    if not morphemes:
        return normalized_text(text)
    return "".join(morpheme["reading"] for morpheme in morphemes)


def build_lyric_ranges(lines):
    normalized_parts = []
    ranges = []
    cursor = 0

    for line in lines:
        normalized, _ = normalize_with_map(line)
        start = cursor
        normalized_parts.append(normalized)
        cursor += len(normalized)
        ranges.append((start, cursor))

    return "".join(normalized_parts), ranges


def make_char_timeline(chunks):
    transcript_chars = []
    char_times = []

    for chunk in chunks:
        words = chunk.get("words") or []
        used_word_times = False

        for word in words:
            text = word.get("text", "")
            start = float(word.get("start", 0.0) or 0.0)
            end = max(start + 0.04, float(word.get("end", start + 0.04) or start + 0.04))
            normalized, _ = normalize_with_map(text)
            if not normalized:
                continue

            used_word_times = True
            for position, char in enumerate(normalized):
                ratio = position / max(1, len(normalized) - 1)
                transcript_chars.append(char)
                char_times.append(start + (end - start) * ratio)

        if used_word_times:
            continue

        text = chunk.get("text", "")
        start = float(chunk.get("start", 0.0) or 0.0)
        end = max(start + 0.05, float(chunk.get("end", start + 0.05) or start + 0.05))
        normalized, source_map = normalize_with_map(text)
        if not normalized:
            continue

        for position, char in enumerate(normalized):
            ratio = position / max(1, len(normalized) - 1)
            transcript_chars.append(char)
            char_times.append(start + (end - start) * ratio)

    return "".join(transcript_chars), char_times


def cluster_transcript_indexes(indexes, transcript_times):
    clusters = []
    current = []

    for value in sorted(set(indexes)):
        if not current:
            current = [value]
            continue

        previous = current[-1]
        index_gap = value - previous
        time_gap = abs(transcript_times[value] - transcript_times[previous]) if value < len(transcript_times) and previous < len(transcript_times) else 0.0

        if index_gap <= 8 and time_gap <= 4.2:
            current.append(value)
        else:
            clusters.append(current)
            current = [value]

    if current:
        clusters.append(current)

    return clusters


def choose_best_cluster(indexes, transcript_times, line_length, cursor):
    clusters = cluster_transcript_indexes(indexes, transcript_times)
    best = None

    for cluster in clusters:
        first = min(cluster)
        last = max(cluster)
        span = max(1, last - first + 1)
        coverage = len(cluster) / max(1, line_length)
        density = len(cluster) / span
        backwards = max(0, cursor - first)
        forward = max(0, first - cursor)
        score = coverage * 0.74 + density * 0.26

        if backwards > 2:
            score -= min(0.45, backwards / max(12, line_length * 2))
        else:
            score -= min(0.18, forward / max(60, line_length * 8))

        candidate = {
            "first": first,
            "last": last,
            "coverage": coverage,
            "density": density,
            "score": score
        }

        if best is None or candidate["score"] > best["score"] or (
            abs(candidate["score"] - best["score"]) <= 0.04 and candidate["first"] < best["first"]
        ):
            best = candidate

    if not best:
        return None

    min_coverage = 0.72 if line_length <= 3 else 0.28
    if best["coverage"] < min_coverage:
        return None
    if best["density"] < 0.14 and best["coverage"] < 0.62:
        return None

    return best


def normalized_text(text):
    normalized, _ = normalize_with_map(text)
    return normalized


def comparison_text(text):
    return alignment_text(text) if contains_japanese(text) else normalized_text(text)


def alignment_text(text):
    chars = []
    source = japanese_reading_text(text) if contains_japanese(text) else normalized_text(text)
    for char in source:
        if re.match(r"[가-힣]", char):
            chars.extend(
                part
                for part in unicodedata.normalize("NFKD", char)
                if re.match(r"[\u1100-\u11ff\u3130-\u318f]", part)
            )
        else:
            chars.append(char)
    return "".join(chars)


def normalized_word(text):
    return normalized_text(unicodedata.normalize("NFKC", str(text)))


def word_similarity(source, target):
    source_plain = normalized_word(source)
    target_plain = normalized_word(target)
    if not source_plain or not target_plain:
        return 0.0
    if source_plain == target_plain:
        return 1.0

    plain_ratio = difflib.SequenceMatcher(None, source_plain, target_plain, autojunk=False).ratio()
    source_phonetic = alignment_text(source)
    target_phonetic = alignment_text(target)
    phonetic_ratio = difflib.SequenceMatcher(None, source_phonetic, target_phonetic, autojunk=False).ratio()
    return max(plain_ratio, phonetic_ratio * 0.96)


def flatten_lyric_words(lines):
    words = []
    line_word_ranges = []
    for line_index, line in enumerate(lines):
        start = len(words)
        morphemes = japanese_morphemes(line)
        if morphemes:
            for line_position, morpheme in enumerate(morphemes):
                words.append({
                    "text": morpheme["surface"],
                    "norm": normalized_word(morpheme["surface"]),
                    "reading": morpheme["reading"],
                    "partOfSpeech": morpheme.get("partOfSpeech", ()),
                    "timingWeight": max(1.0, mora_count(morpheme["reading"])),
                    "line": line_index,
                    "linePosition": line_position,
                    "displayStart": morpheme["start"],
                    "displayEnd": morpheme["end"]
                })
            line_word_ranges.append((start, len(words)))
            continue

        matches = list(re.finditer(r"[^\W_]+(?:['’][^\W_]+)?", line, re.UNICODE))
        if not matches:
            matches = [re.match(r".*", line)]
        for line_position, match in enumerate(matches):
            word = match.group(0)
            words.append({
                "text": word,
                "norm": normalized_word(word),
                "reading": normalized_word(word),
                "timingWeight": max(1.0, len(normalized_word(word))),
                "line": line_index,
                "linePosition": line_position,
                "displayStart": match.start(),
                "displayEnd": match.end()
            })
        line_word_ranges.append((start, len(words)))
    return words, line_word_ranges


def flatten_transcript_words(chunks):
    words = []
    for chunk_index, chunk in enumerate(chunks):
        timed_words = chunk.get("words") or []
        if not timed_words:
            raw_words = re.findall(r"[^\W_]+(?:['’][^\W_]+)?", chunk.get("text", ""), re.UNICODE)
            start = float(chunk.get("start", 0.0) or 0.0)
            end = max(start + 0.1, float(chunk.get("end", start + 0.1) or start + 0.1))
            total_weight = max(1, sum(max(1, len(normalized_word(word))) for word in raw_words))
            cursor = start
            for raw_word in raw_words:
                span = (end - start) * max(1, len(normalized_word(raw_word))) / total_weight
                timed_words.append({
                    "text": raw_word,
                    "start": cursor,
                    "end": min(end, cursor + span),
                    "probability": 0.35
                })
                cursor += span

        for word in timed_words:
            text = str(word.get("text", "")).strip()
            norm = normalized_word(text)
            if not norm:
                continue
            start = float(word.get("start", chunk.get("start", 0.0)) or 0.0)
            end = max(start + 0.04, float(word.get("end", start + 0.04) or start + 0.04))
            raw_end = float(word.get("end", start) or start)
            probability = float(word.get("probability", 0.45) or 0.45)
            if raw_end - start < 0.025 or probability < 0.02:
                continue
            words.append({
                "text": text,
                "norm": norm,
                "start": start,
                "end": end,
                "probability": probability,
                "chunk": chunk_index,
                "chunkStart": float(chunk.get("start", start) or start),
                "chunkEnd": float(chunk.get("end", end) or end)
            })
    return words


def fuzzy_word_pairs(lyric_words, transcript_words, threshold=0.54):
    lyric_count = len(lyric_words)
    transcript_count = len(transcript_words)
    if lyric_count == 0 or transcript_count == 0 or lyric_count * transcript_count > 180000:
        return []

    similarities = [[0.0] * transcript_count for _ in range(lyric_count)]
    for lyric_index, lyric_word in enumerate(lyric_words):
        for transcript_index, transcript_word in enumerate(transcript_words):
            score = word_similarity(lyric_word["text"], transcript_word["text"])
            shortest = min(len(lyric_word["norm"]), len(transcript_word["norm"]))
            required = 0.72 if shortest <= 2 else threshold
            if score >= required:
                similarities[lyric_index][transcript_index] = score

    dp = [[0.0] * (transcript_count + 1) for _ in range(lyric_count + 1)]
    for lyric_index in range(lyric_count - 1, -1, -1):
        for transcript_index in range(transcript_count - 1, -1, -1):
            best = max(dp[lyric_index + 1][transcript_index], dp[lyric_index][transcript_index + 1])
            similarity = similarities[lyric_index][transcript_index]
            if similarity:
                best = max(best, similarity + dp[lyric_index + 1][transcript_index + 1])
            dp[lyric_index][transcript_index] = best

    pairs = []
    lyric_index = 0
    transcript_index = 0
    while lyric_index < lyric_count and transcript_index < transcript_count:
        similarity = similarities[lyric_index][transcript_index]
        diagonal = similarity + dp[lyric_index + 1][transcript_index + 1]
        if similarity and abs(dp[lyric_index][transcript_index] - diagonal) < 1e-8:
            pairs.append((lyric_index, transcript_index, similarity))
            lyric_index += 1
            transcript_index += 1
        elif dp[lyric_index + 1][transcript_index] >= dp[lyric_index][transcript_index + 1]:
            lyric_index += 1
        else:
            transcript_index += 1
    return pairs


def build_word_anchors(lines, chunks):
    lyric_words, line_word_ranges = flatten_lyric_words(lines)
    transcript_words = flatten_transcript_words(chunks)
    anchors = [None] * len(lyric_words)
    lyric_norms = [word["norm"] for word in lyric_words]
    transcript_norms = [word["norm"] for word in transcript_words]
    matcher = difflib.SequenceMatcher(None, lyric_norms, transcript_norms, autojunk=False)

    for block in matcher.get_matching_blocks():
        for offset in range(block.size):
            lyric_index = block.a + offset
            transcript_index = block.b + offset
            token_length = len(lyric_norms[lyric_index])
            if block.size == 1 and token_length <= 1:
                continue
            anchors[lyric_index] = {
                "transcriptIndex": transcript_index,
                "score": max(0.78, transcript_words[transcript_index]["probability"]),
                "source": "exact",
                **transcript_words[transcript_index]
            }

    opcodes = matcher.get_opcodes()
    for tag, lyric_start, lyric_end, transcript_start, transcript_end in opcodes:
        if tag == "equal" or lyric_start == lyric_end or transcript_start == transcript_end:
            continue
        lyric_block = lyric_words[lyric_start:lyric_end]
        transcript_block = transcript_words[transcript_start:transcript_end]
        for lyric_offset, transcript_offset, score in fuzzy_word_pairs(lyric_block, transcript_block):
            lyric_index = lyric_start + lyric_offset
            if anchors[lyric_index] is not None:
                continue
            transcript_index = transcript_start + transcript_offset
            anchors[lyric_index] = {
                "transcriptIndex": transcript_index,
                "score": min(0.86, max(0.5, score)),
                "source": "fuzzy",
                **transcript_words[transcript_index]
            }

    return lyric_words, line_word_ranges, transcript_words, anchors


AUTO_SEGMENT_TRIGGER_WIDTH = 58.0
AUTO_SEGMENT_TARGET_WIDTH = 38.0
AUTO_SEGMENT_MAX_WIDTH = 52.0
AUTO_SEGMENT_MIN_WIDTH = 18.0


def display_width_units(text):
    width = 0.0
    for char in str(text):
        if unicodedata.combining(char):
            continue
        if char.isspace():
            width += 0.45
        elif unicodedata.east_asian_width(char) in ("W", "F"):
            width += 2.0
        else:
            width += 1.0
    return width


def lyrics_need_auto_segmentation(lines):
    return any(display_width_units(line) > AUTO_SEGMENT_TRIGGER_WIDTH for line in lines)


def lyric_boundary_signal(line, words, anchors, boundary):
    if boundary <= 0 or boundary >= len(words):
        return 0.0, False

    previous_word = words[boundary - 1]
    next_word = words[boundary]
    cut = int(next_word.get("displayStart", 0) or 0)
    prefix = line[:cut].rstrip()
    reward = 0.0
    audio_guided = False

    if re.search(r"[.!?。！？…]+['\"’”」』）)]*$", prefix):
        reward += 1.05
    elif re.search(r"[,:;，、：；]+['\"’”」』）)]*$", prefix):
        reward += 0.45

    gap = line[int(previous_word.get("displayEnd", cut) or cut):cut]
    if gap and not gap.strip():
        reward += 0.08

    if contains_japanese(line):
        previous_text = normalized_word(previous_word.get("text", ""))
        next_text = normalized_word(next_word.get("text", ""))
        next_part = tuple(next_word.get("partOfSpeech", ()))
        continuation_pair = (previous_text, next_text) in {
            ("と", "し"), ("に", "な"), ("で", "あ"), ("て", "い"),
            ("て", "く"), ("て", "しま"), ("たり", "し"),
        }
        grammatical_continuation = any(
            category in {"助詞", "助動詞", "接尾辞"}
            for category in next_part[:1]
        ) or continuation_pair or next_text in {
            "は", "が", "を", "に", "へ", "と", "で", "の", "も", "や", "か", "ね", "よ",
            "から", "まで", "より", "って", "ので", "のに", "たり", "て", "ない", "ながら",
            "けど", "けれど", "なら", "れば", "して", "しても"
        }
        if grammatical_continuation:
            reward -= 3.0

    previous_anchor = anchors[boundary - 1] if boundary - 1 < len(anchors) else None
    next_anchor = anchors[boundary] if boundary < len(anchors) else None
    if previous_anchor and next_anchor:
        previous_index = int(previous_anchor.get("transcriptIndex", -1))
        next_index = int(next_anchor.get("transcriptIndex", -1))
        if next_index > previous_index:
            pause = max(
                0.0,
                float(next_anchor.get("start", 0.0) or 0.0)
                - float(previous_anchor.get("end", 0.0) or 0.0)
            )
            if pause >= 0.55:
                reward += 1.35
                audio_guided = True
            elif pause >= 0.32:
                reward += 0.9
                audio_guided = True
            elif pause >= 0.18:
                reward += 0.38
                audio_guided = True

            if previous_anchor.get("chunk") != next_anchor.get("chunk"):
                reward += 0.28
                audio_guided = True

    return min(2.4, reward), audio_guided


def split_long_lyric_line(line, words, anchors):
    if display_width_units(line) <= AUTO_SEGMENT_TRIGGER_WIDTH or len(words) < 2:
        return [line], 0

    cuts = [0]
    for word in words[1:]:
        cut = max(cuts[-1], min(len(line), int(word.get("displayStart", cuts[-1]) or cuts[-1])))
        cuts.append(cut)
    cuts.append(len(line))

    if len(set(cuts)) < 3:
        return [line], 0

    signals = [(0.0, False)] * (len(words) + 1)
    for boundary in range(1, len(words)):
        signals[boundary] = lyric_boundary_signal(line, words, anchors, boundary)

    count = len(words)
    costs = [math.inf] * (count + 1)
    previous = [None] * (count + 1)
    costs[0] = 0.0

    for end in range(1, count + 1):
        for start in range(end - 1, -1, -1):
            segment = line[cuts[start]:cuts[end]].strip()
            width = display_width_units(segment)
            if width <= 0:
                continue
            if (
                width < AUTO_SEGMENT_MIN_WIDTH
                and end < count
                and not re.search(r"[.!?。！？…]+['\"’”」』）)]*$", segment)
            ):
                continue
            if width > AUTO_SEGMENT_MAX_WIDTH * 1.7 and end - start > 1:
                break
            if not math.isfinite(costs[start]):
                continue

            if width > AUTO_SEGMENT_MAX_WIDTH:
                length_penalty = 1.8 + ((width - AUTO_SEGMENT_MAX_WIDTH) / 8.0) ** 2
            elif width < AUTO_SEGMENT_MIN_WIDTH and end < count:
                length_penalty = 0.9 * (AUTO_SEGMENT_MIN_WIDTH - width) / AUTO_SEGMENT_MIN_WIDTH
            else:
                length_penalty = 0.38 * abs(width - AUTO_SEGMENT_TARGET_WIDTH) / AUTO_SEGMENT_TARGET_WIDTH

            boundary_reward = signals[end][0] if end < count else 0.0
            candidate_cost = costs[start] + 0.24 + length_penalty - boundary_reward
            if candidate_cost < costs[end]:
                costs[end] = candidate_cost
                previous[end] = start

    if previous[count] is None:
        return [line], 0

    ranges = []
    cursor = count
    while cursor > 0:
        start = previous[cursor]
        if start is None:
            return [line], 0
        ranges.append((start, cursor))
        cursor = start
    ranges.reverse()

    # Avoid leaving a tiny fragment at either edge when it fits naturally in
    # its neighbor. Slice with the original offsets so Japanese text does not
    # gain spaces and Latin text keeps its existing whitespace.
    if len(ranges) > 1:
        first_width = display_width_units(
            line[cuts[ranges[0][0]]:cuts[ranges[0][1]]].strip()
        )
        merged_first = (ranges[0][0], ranges[1][1])
        merged_first_width = display_width_units(
            line[cuts[merged_first[0]]:cuts[merged_first[1]]].strip()
        )
        if (
            first_width < AUTO_SEGMENT_MIN_WIDTH
            and merged_first_width <= AUTO_SEGMENT_MAX_WIDTH * 1.15
        ):
            ranges[0:2] = [merged_first]

    if len(ranges) > 1:
        last_width = display_width_units(
            line[cuts[ranges[-1][0]]:cuts[ranges[-1][1]]].strip()
        )
        merged_last = (ranges[-2][0], ranges[-1][1])
        merged_last_width = display_width_units(
            line[cuts[merged_last[0]]:cuts[merged_last[1]]].strip()
        )
        if (
            last_width < AUTO_SEGMENT_MIN_WIDTH
            and merged_last_width <= AUTO_SEGMENT_MAX_WIDTH * 1.15
        ):
            ranges[-2:] = [merged_last]

    segments = [line[cuts[start]:cuts[end]].strip() for start, end in ranges]
    segments = [segment for segment in segments if segment]
    if len(segments) <= 1:
        return [line], 0

    audio_boundaries = sum(1 for _, end in ranges[:-1] if signals[end][1])
    return segments, audio_boundaries


def auto_segment_lyrics(lines, chunks):
    metadata = {
        "applied": False,
        "originalLines": len(lines),
        "resultLines": len(lines),
        "longLines": 0,
        "audioGuidedBoundaries": 0
    }
    if not lyrics_need_auto_segmentation(lines):
        return list(lines), metadata

    lyric_words, line_word_ranges, _, anchors = build_word_anchors(lines, chunks)
    segmented = []
    for line_index, line in enumerate(lines):
        if display_width_units(line) <= AUTO_SEGMENT_TRIGGER_WIDTH:
            segmented.append(line)
            continue

        metadata["longLines"] += 1
        word_start, word_end = line_word_ranges[line_index]
        parts, audio_boundaries = split_long_lyric_line(
            line,
            lyric_words[word_start:word_end],
            anchors[word_start:word_end]
        )
        segmented.extend(parts)
        metadata["audioGuidedBoundaries"] += audio_boundaries

    metadata["applied"] = len(segmented) > len(lines)
    metadata["resultLines"] = len(segmented)
    return segmented, metadata


def split_display_units(text):
    units = []
    for index, char in enumerate(str(text)):
        variation_selector = "\ufe00" <= char <= "\ufe0f"
        if units and (unicodedata.combining(char) or variation_selector or char == "\u200d"):
            units[-1]["text"] += char
            units[-1]["end"] = index + 1
            continue
        units.append({"text": char, "start": index, "end": index + 1})
    return units


def word_unit_timing_weights(word, units, unit_indexes):
    if not unit_indexes:
        return []

    total_weight = max(1.0, float(word.get("timingWeight", 0.0) or 0.0))
    small_kana = set("ぁぃぅぇぉゃゅょゎゕゖァィゥェォャュョヮヵヶ")
    base_weights = []
    ideograph_positions = []

    for position, unit_index in enumerate(unit_indexes):
        text = units[unit_index]["text"]
        if any(is_cjk_ideograph(char) for char in text):
            base_weights.append(0.0)
            ideograph_positions.append(position)
        elif any(char in small_kana for char in text):
            base_weights.append(0.15)
        else:
            base_weights.append(max(1.0, float(len(normalized_text(text)))))

    if ideograph_positions:
        known_weight = sum(base_weights)
        remaining = max(len(ideograph_positions) * 0.4, total_weight - known_weight)
        per_ideograph = remaining / len(ideograph_positions)
        for position in ideograph_positions:
            base_weights[position] = per_ideograph

    measured_total = sum(base_weights)
    if measured_total <= 0:
        return [total_weight / len(unit_indexes)] * len(unit_indexes)

    scale = total_weight / measured_total
    return [max(0.03, weight * scale) for weight in base_weights]


def weighted_boundaries(words, anchors, row_start, row_end):
    count = len(words)
    if count == 0:
        return [row_start, row_end], []

    candidates = [[] for _ in range(count + 1)]
    candidates[0].append(row_start)
    candidates[count].append(row_end)
    confidences = []

    for index, anchor in enumerate(anchors):
        confidence = 0.0
        if anchor:
            anchor_start = float(anchor.get("start", row_start) or row_start)
            anchor_end = float(anchor.get("end", anchor_start + 0.04) or anchor_start + 0.04)
            if anchor_end >= row_start - 0.4 and anchor_start <= row_end + 0.4:
                candidates[index].append(max(row_start, min(row_end, anchor_start)))
                candidates[index + 1].append(max(row_start, min(row_end, anchor_end)))
                confidence = float(anchor.get("score", anchor.get("probability", 0.45)) or 0.45)
        confidences.append(confidence)

    boundaries = [None] * (count + 1)
    for index, values in enumerate(candidates):
        if values:
            boundaries[index] = sum(values) / len(values)

    known = [index for index, value in enumerate(boundaries) if value is not None]
    for known_index in range(len(known) - 1):
        left = known[known_index]
        right = known[known_index + 1]
        left_time = boundaries[left]
        right_time = max(left_time, boundaries[right])
        weights = [
            max(1.0, float(words[index].get("timingWeight", len(words[index].get("norm", ""))) or 1.0))
            for index in range(left, right)
        ]
        total_weight = max(1, sum(weights))
        consumed = 0
        for index in range(left + 1, right):
            consumed += weights[index - left - 1]
            boundaries[index] = left_time + (right_time - left_time) * consumed / total_weight

    minimum_span = min(0.035, max(0.008, (row_end - row_start) / max(1, count * 8)))
    boundaries[0] = row_start
    boundaries[-1] = row_end
    for index in range(1, len(boundaries)):
        boundaries[index] = max(boundaries[index - 1] + minimum_span, float(boundaries[index]))
    if boundaries[-1] > row_end:
        boundaries[-1] = row_end
        for index in range(len(boundaries) - 2, -1, -1):
            boundaries[index] = min(boundaries[index], boundaries[index + 1] - minimum_span)
        boundaries[0] = row_start

    return boundaries, confidences


def build_line_token_timeline(line, row, words, anchors):
    row_start = float(row.get("start", 0.0) or 0.0)
    row_end = max(row_start + 0.1, float(row.get("end", row_start + 0.1) or row_start + 0.1))
    line_confidence = float(row.get("confidence", 0.0) or 0.0)
    units = split_display_units(line)
    if not units:
        return []

    boundaries, word_confidences = weighted_boundaries(words, anchors, row_start, row_end)
    assignments = [None] * len(units)

    for word_index, word in enumerate(words):
        unit_indexes = [
            index for index, unit in enumerate(units)
            if unit["start"] >= word.get("displayStart", 0)
            and unit["end"] <= word.get("displayEnd", len(line))
            and not unit["text"].isspace()
        ]
        if not unit_indexes:
            continue

        start = boundaries[word_index]
        end = max(start + 0.02, boundaries[word_index + 1])
        weights = word_unit_timing_weights(word, units, unit_indexes)
        total_weight = max(1, sum(weights))
        consumed = 0
        for position, unit_index in enumerate(unit_indexes):
            token_start = start + (end - start) * consumed / total_weight
            consumed += weights[position]
            token_end = start + (end - start) * consumed / total_weight
            anchored = word_confidences[word_index] > 0
            assignments[unit_index] = {
                "start": token_start,
                "end": max(token_start + 0.015, token_end),
                "confidence": word_confidences[word_index] if anchored else line_confidence * 0.55,
                "source": anchors[word_index].get("source", "word") if anchored else "estimated-word",
                "timed": True
            }

    timed_indexes = [index for index, value in enumerate(assignments) if value]
    if not timed_indexes:
        visible = [index for index, unit in enumerate(units) if not unit["text"].isspace()]
        fallback_word = {
            "timingWeight": max(1.0, mora_count(japanese_reading_text(line)))
            if contains_japanese(line) else max(1.0, len(normalized_text(line)))
        }
        weights = word_unit_timing_weights(fallback_word, units, visible)
        total_weight = max(1.0, sum(weights))
        consumed = 0.0
        for position, unit_index in enumerate(visible):
            token_start = row_start + (row_end - row_start) * consumed / total_weight
            consumed += weights[position]
            token_end = row_start + (row_end - row_start) * consumed / total_weight
            assignments[unit_index] = {
                "start": token_start,
                "end": token_end,
                "confidence": line_confidence * 0.45,
                "source": "estimated-line",
                "timed": True
            }
        timed_indexes = visible

    previous_time = row_start
    next_times = [None] * len(units)
    upcoming = row_end
    for index in range(len(units) - 1, -1, -1):
        if assignments[index]:
            upcoming = assignments[index]["start"]
        next_times[index] = upcoming

    tokens = []
    for index, unit in enumerate(units):
        timing = assignments[index]
        if timing:
            previous_time = timing["end"]
        else:
            marker = min(next_times[index], previous_time) if unit["text"].isspace() else previous_time
            timing = {
                "start": marker,
                "end": marker,
                "confidence": line_confidence * 0.4,
                "source": "separator",
                "timed": False
            }
        tokens.append({
            "index": index,
            "text": unit["text"],
            "start": round(max(row_start, min(row_end, timing["start"])), 3),
            "end": round(max(row_start, min(row_end, timing["end"])), 3),
            "confidence": round(max(0.0, min(1.0, timing["confidence"])), 3),
            "source": timing["source"],
            "timed": timing["timed"]
        })
    return tokens


def attach_token_timelines(lines, timeline, chunks):
    if not timeline:
        return timeline

    lyric_words, line_word_ranges, _, word_anchors = build_word_anchors(lines, chunks)
    for line_index, row in enumerate(timeline):
        word_start, word_end = line_word_ranges[line_index]
        row_words = lyric_words[word_start:word_end]
        row_anchors = word_anchors[word_start:word_end]
        row["tokens"] = build_line_token_timeline(lines[line_index], row, row_words, row_anchors)
        timed = [token for token in row["tokens"] if token.get("timed")]
        row["tokenConfidence"] = round(
            sum(float(token.get("confidence", 0.0) or 0.0) for token in timed) / max(1, len(timed)),
            3
        )
    return timeline


def build_character_line_anchors(lines, chunks):
    lyric_parts = []
    lyric_ranges = []
    lyric_cursor = 0
    for line in lines:
        part = alignment_text(line)
        lyric_parts.append(part)
        lyric_ranges.append((lyric_cursor, lyric_cursor + len(part)))
        lyric_cursor += len(part)

    transcript_chars = []
    transcript_times = []
    transcript_ends = []
    transcript_chunk_starts = []
    transcript_chunk_ends = []
    for word in flatten_transcript_words(chunks):
        part = alignment_text(word["text"])
        if not part:
            continue
        for position, char in enumerate(part):
            start_ratio = position / max(1, len(part))
            end_ratio = (position + 1) / max(1, len(part))
            transcript_chars.append(char)
            transcript_times.append(word["start"] + (word["end"] - word["start"]) * start_ratio)
            transcript_ends.append(word["start"] + (word["end"] - word["start"]) * end_ratio)
            transcript_chunk_starts.append(float(word.get("chunkStart", word["start"])))
            transcript_chunk_ends.append(float(word.get("chunkEnd", word["end"])))

    lyric_text = "".join(lyric_parts)
    transcript_text = "".join(transcript_chars)
    if not lyric_text or not transcript_text:
        return [None] * len(lines)

    mapping = {}
    matcher = difflib.SequenceMatcher(None, lyric_text, transcript_text, autojunk=False)
    for block in matcher.get_matching_blocks():
        for offset in range(block.size):
            mapping[block.a + offset] = block.b + offset

    result = []
    for start, end in lyric_ranges:
        line_length = max(1, end - start)
        mapped_pairs = [(index, mapping[index]) for index in range(start, end) if index in mapping]
        if not mapped_pairs:
            result.append(None)
            continue
        transcript_indexes = [transcript_index for _, transcript_index in mapped_pairs]
        coverage = len(transcript_indexes) / line_length
        minimum = 0.5 if line_length <= 4 else 0.2
        if coverage < minimum or (len(transcript_indexes) < 3 and line_length > 4):
            result.append(None)
            continue
        first = min(transcript_indexes)
        last = max(transcript_indexes)
        density = len(transcript_indexes) / max(1, last - first + 1)
        if density < 0.08 and coverage < 0.55:
            result.append(None)
            continue
        first_lyric_index = min(index for index, _ in mapped_pairs)
        last_lyric_index = max(index for index, _ in mapped_pairs)
        anchor_start = transcript_times[first]
        anchor_end = transcript_ends[last]
        if first_lyric_index > start:
            anchor_start = min(anchor_start, transcript_chunk_starts[first])
        if last_lyric_index < end - 1:
            anchor_end = max(anchor_end, transcript_chunk_ends[last])
        result.append({
            "start": anchor_start,
            "end": anchor_end,
            "score": min(0.9, 0.48 + coverage * 0.34 + min(0.08, density * 0.08)),
            "coverage": coverage,
            "source": "character"
        })
    return result


def similarity_details(source, target):
    if not source or not target:
        return {
            "ratio": 0.0,
            "source_coverage": 0.0,
            "target_coverage": 0.0,
            "balance": 0.0,
            "matched": 0
        }

    matcher = difflib.SequenceMatcher(None, source, target, autojunk=False)
    matched = sum(block.size for block in matcher.get_matching_blocks())
    longer = max(len(source), len(target), 1)

    return {
        "ratio": matcher.ratio(),
        "source_coverage": matched / max(1, len(source)),
        "target_coverage": matched / max(1, len(target)),
        "balance": min(len(source), len(target)) / longer,
        "matched": matched
    }


def lyric_line_weight(line):
    normalized = comparison_text(line)
    if re.fullmatch(r"(woo|woah|oh|ah|음|우|오)+", normalized or ""):
        return 4
    return max(4, len(normalized))


def is_adlib_line(line):
    normalized = normalized_text(line)
    if not normalized:
        return True

    return bool(re.fullmatch(r"(woo|woah|ooh|oh|ah|음|우|오)+", normalized)) or len(normalized) <= 3


def choose_chunk_group(lines, line_norms, cursor, chunk_text, max_lookahead=3, max_lines=4, skip_penalty=0.14):
    chunk_norm = comparison_text(chunk_text)
    if len(chunk_norm) < 2:
        return None

    best = None
    search_end = min(len(lines), cursor + max_lookahead + 1)

    for start_index in range(cursor, search_end):
        skipped = start_index - cursor
        combined = ""

        for count in range(1, max_lines + 1):
            end_index = start_index + count
            if end_index > len(lines):
                break

            combined += line_norms[end_index - 1]
            if not combined:
                continue

            details = similarity_details(combined, chunk_norm)
            individual = [
                similarity_details(line_norms[line_index], chunk_norm)
                for line_index in range(start_index, end_index)
                if line_norms[line_index]
            ]
            weak_line_penalty = sum(
                0.22 for item in individual
                if (
                    (item["source_coverage"] < 0.18 and item["ratio"] < 0.18)
                    or (item["source_coverage"] < 0.4 and item["ratio"] < 0.16)
                )
            )
            score = (
                details["ratio"] * 0.34
                + details["source_coverage"] * 0.34
                + details["target_coverage"] * 0.24
                + details["balance"] * 0.08
                - skipped * skip_penalty
                - weak_line_penalty
            )

            if count > 3:
                score -= 0.04 * (count - 3)

            candidate = {
                "start_index": start_index,
                "count": count,
                "score": score,
                **details
            }

            if best is None or candidate["score"] > best["score"]:
                best = candidate

    if not best:
        return None

    if best["score"] < 0.42:
        return None
    if best["source_coverage"] < 0.36 and best["ratio"] < 0.32:
        return None
    if best["target_coverage"] < 0.18 and best["ratio"] < 0.42:
        return None

    return best


def assign_chunk_to_lines(timeline, lines, chunk, group):
    start_index = group["start_index"]
    count = group["count"]
    start_time = float(chunk.get("start", 0.0) or 0.0)
    end_time = max(start_time + 0.35, float(chunk.get("end", start_time + 0.35) or start_time + 0.35))
    span = end_time - start_time
    weights = [lyric_line_weight(lines[start_index + offset]) for offset in range(count)]
    total_weight = max(1, sum(weights))
    cursor_time = start_time

    for offset in range(count):
        index = start_index + offset
        line_span = span * (weights[offset] / total_weight)
        line_start = cursor_time
        line_end = end_time if offset == count - 1 else min(end_time, cursor_time + line_span)
        cursor_time = line_end

        timeline[index]["start"] = line_start
        timeline[index]["end"] = max(line_start + 0.35, line_end)
        timeline[index]["confidence"] = max(
            timeline[index].get("confidence", 0.0),
            min(0.96, max(0.38, group["score"]))
        )


def timeline_quality_score(lines, timeline, matched_lines):
    if not timeline:
        return 0.0

    total = max(1, len(lines))
    matched_ratio = matched_lines / total
    avg_confidence = sum(float(row.get("confidence", 0.0) or 0.0) for row in timeline) / total
    low_confidence_ratio = sum(
        1 for row in timeline
        if float(row.get("confidence", 0.0) or 0.0) < 0.35
    ) / total

    penalty = 0.0
    bonus = 0.0
    for row in timeline:
        line_duration = max(0.0, float(row.get("end", 0.0) or 0.0) - float(row.get("start", 0.0) or 0.0))
        normalized_length = len(normalized_text(row.get("text", "")))
        expected_max_duration = max(8.0, min(14.0, 5.2 + normalized_length * 0.4))
        if not is_adlib_line(row.get("text", "")) and line_duration > expected_max_duration:
            penalty += min(0.75, (line_duration - expected_max_duration) * 0.05)

    first = timeline[0]
    first_duration = max(0.0, float(first.get("end", 0.0) or 0.0) - float(first.get("start", 0.0) or 0.0))
    first_start = float(first.get("start", 0.0) or 0.0)
    if first_start <= 1.0 and first_duration >= 8.0:
        penalty += 0.35
    elif 6.0 <= first_start <= 35.0 and float(first.get("confidence", 0.0) or 0.0) >= 0.5:
        bonus += 0.08
    elif first_start > 35.0:
        penalty += 0.22

    duration = max(float(row.get("end", 0.0) or 0.0) for row in timeline)
    tail_rows = [row for row in timeline if not is_adlib_line(row.get("text", ""))][-4:]
    late_tail_rows = [
        row for row in tail_rows
        if float(row.get("confidence", 0.0) or 0.0) >= 0.55
        and (duration <= 0 or float(row.get("start", 0.0) or 0.0) >= duration - 40.0)
    ]
    if len(late_tail_rows) >= 3:
        bonus += 0.18

    return max(0.0, min(1.0, matched_ratio * 0.62 + avg_confidence * 0.32 - low_confidence_ratio * 0.12 + bonus - penalty))


def transcript_health_score(chunks):
    words = [word for chunk in chunks for word in (chunk.get("words") or [])]
    if not words:
        return 0.0
    valid = 0
    for word in words:
        start = float(word.get("start", 0.0) or 0.0)
        end = float(word.get("end", start) or start)
        probability = float(word.get("probability", 0.45) or 0.45)
        if end - start >= 0.025 and probability >= 0.02:
            valid += 1
    return valid / len(words)


def build_alignment_candidate(label, lines, chunks, duration):
    timeline, matched_lines, alignment_method = align_lines_to_transcript(lines, chunks, duration)
    return {
        "label": label,
        "alignmentMethod": alignment_method,
        "chunks": chunks,
        "duration": duration,
        "timeline": timeline,
        "matchedLines": matched_lines,
        "quality": timeline_quality_score(lines, timeline, matched_lines),
        "transcriptHealth": transcript_health_score(chunks)
    }


def assess_lyrics_compatibility(lines, candidate):
    total_lines = max(1, len(lines))
    matched_lines = int(candidate.get("matchedLines", 0) or 0)
    matched_ratio = matched_lines / total_lines
    quality = float(candidate.get("quality", 0.0) or 0.0)
    transcript_words = len(flatten_transcript_words(candidate.get("chunks", [])))
    duration = float(candidate.get("duration", 0.0) or 0.0)
    score = max(0.0, min(1.0, matched_ratio * 0.72 + quality * 0.28))

    minimum_words = max(6, min(16, math.ceil(total_lines * 0.18)))
    if total_lines >= 6 and duration >= 30.0 and transcript_words < minimum_words:
        status = "insufficient-vocals"
        reason = "보컬을 충분히 인식하지 못했습니다. AR/원곡 파일인지 확인하세요."
    elif (
        (total_lines >= 6 and matched_ratio < 0.42 and quality < 0.16 and score < 0.30)
        or (total_lines < 6 and matched_lines == 0 and transcript_words >= 8)
    ):
        status = "mismatch"
        reason = "오디오의 독립 인식 결과와 입력 가사가 거의 일치하지 않습니다."
    elif matched_ratio < 0.50 or quality < 0.25:
        status = "low"
        reason = "오디오와 가사의 일치 근거가 약해 일부 줄은 수동 보정이 필요할 수 있습니다."
    else:
        status = "compatible"
        reason = "오디오와 가사가 일치합니다."

    return {
        "status": status,
        "score": round(score, 3),
        "matchedLines": matched_lines,
        "matchedRatio": round(matched_ratio, 3),
        "quality": round(quality, 3),
        "transcriptWords": transcript_words,
        "reason": reason
    }


def align_lines_global(lines, chunks, duration):
    timeline = []
    for index, line in enumerate(lines):
        timeline.append({
            "id": f"line-{index + 1}",
            "index": index,
            "text": line,
            "start": math.nan,
            "end": math.nan,
            "confidence": 0.0,
            "source": "estimated"
        })

    lyric_words, line_word_ranges, _, word_anchors = build_word_anchors(lines, chunks)
    character_anchors = build_character_line_anchors(lines, chunks)

    for line_index, (word_start, word_end) in enumerate(line_word_ranges):
        anchored_words = [
            (word_index, word_anchors[word_index])
            for word_index in range(word_start, word_end)
            if word_anchors[word_index] is not None
        ]
        character_anchor = character_anchors[line_index]
        candidates = []

        if anchored_words:
            first_word_index, first_anchor = anchored_words[0]
            last_word_index, last_anchor = anchored_words[-1]
            missing_prefix = first_word_index - word_start
            missing_suffix = word_end - last_word_index - 1
            start = float(first_anchor["start"])
            end = float(last_anchor["end"])

            if missing_prefix:
                start = max(
                    float(first_anchor["chunkStart"]),
                    start - min(1.4, missing_prefix * 0.28)
                )
            if missing_suffix:
                end = min(
                    float(last_anchor["chunkEnd"]),
                    end + min(1.4, missing_suffix * 0.3)
                )

            exact_count = sum(1 for _, anchor in anchored_words if anchor["source"] == "exact")
            coverage = len(anchored_words) / max(1, word_end - word_start)
            score = min(0.97, 0.54 + coverage * 0.3 + min(0.1, exact_count * 0.025))
            candidates.append({
                "start": start,
                "end": max(start + 0.25, end),
                "score": score,
                "source": "word"
            })

        if character_anchor:
            candidates.append(character_anchor)

        if not candidates:
            continue

        candidates.sort(key=lambda item: item["score"], reverse=True)
        best = candidates[0]
        if len(candidates) > 1:
            other = candidates[1]
            if abs(best["start"] - other["start"]) <= 1.2:
                total_score = best["score"] + other["score"]
                best = {
                    "start": (best["start"] * best["score"] + other["start"] * other["score"]) / total_score,
                    "end": max(best["end"], other["end"]),
                    "score": min(0.98, max(best["score"], other["score"]) + 0.03),
                    "source": "word+character"
                }

        timeline[line_index]["start"] = max(0.0, float(best["start"]))
        timeline[line_index]["end"] = max(timeline[line_index]["start"] + 0.25, float(best["end"]))
        timeline[line_index]["confidence"] = float(best["score"])
        timeline[line_index]["source"] = best["source"]

    previous_index = None
    for index, row in enumerate(timeline):
        if not math.isfinite(row["start"]):
            continue
        if previous_index is not None:
            previous = timeline[previous_index]
            if row["start"] <= previous["start"] + 0.08:
                if row["confidence"] > previous["confidence"] + 0.08:
                    previous["start"] = math.nan
                    previous["end"] = math.nan
                    previous["confidence"] = 0.0
                    previous["source"] = "estimated"
                else:
                    row["start"] = math.nan
                    row["end"] = math.nan
                    row["confidence"] = 0.0
                    row["source"] = "estimated"
                    continue
        previous_index = index

    prune_impossible_anchor_spacing(timeline)
    matched_lines = sum(1 for row in timeline if math.isfinite(row["start"]))

    fill_missing_lines(timeline, duration)
    return timeline, matched_lines


def anchor_strength(row):
    source = str(row.get("source", ""))
    source_bonus = 0.08 if "word" in source else 0.0
    source_bonus += 0.03 if "+" in source else 0.0
    return float(row.get("confidence", 0.0) or 0.0) + source_bonus


def minimum_line_spacing(text):
    if is_adlib_line(text):
        return 0.28
    length = len(normalized_text(text))
    return max(0.62, min(1.18, 0.42 + length * 0.035))


def minimum_start_span(rows, left_index, right_index):
    return sum(minimum_line_spacing(rows[index].get("text", "")) for index in range(left_index, right_index))


def prune_impossible_anchor_spacing(timeline):
    while True:
        known = [row for row in timeline if math.isfinite(row.get("start", math.nan))]
        conflict = None
        for previous, current in zip(known, known[1:]):
            line_gap = int(current["index"]) - int(previous["index"])
            time_gap = float(current["start"]) - float(previous["start"])
            required_gap = minimum_start_span(timeline, int(previous["index"]), int(current["index"]))
            if line_gap > 0 and time_gap < required_gap:
                conflict = (previous, current)
                break
        if not conflict:
            return

        previous, current = conflict
        rejected = previous if anchor_strength(previous) < anchor_strength(current) else current
        rejected["start"] = math.nan
        rejected["end"] = math.nan
        rejected["confidence"] = 0.0
        rejected["source"] = "estimated"


def align_lines_greedy(lines, chunks, duration):
    line_norms = [comparison_text(line) for line in lines]
    timeline = []
    for index, line in enumerate(lines):
        timeline.append({
            "id": f"line-{index + 1}",
            "index": index,
            "text": line,
            "start": math.nan,
            "end": math.nan,
            "confidence": 0.0,
            "source": "estimated"
        })

    cursor = 0
    chunk_index = 0
    matched_lines = 0
    last_assigned_time = None
    while chunk_index < len(chunks):
        if cursor >= len(lines):
            break

        chunk = chunks[chunk_index]
        chunk_start = float(chunk.get("start", 0.0) or 0.0)
        choices = []
        combined_text = ""
        combined_words = []
        combined_end = float(chunk.get("end", chunk_start) or chunk_start)

        for chunk_count in range(1, min(3, len(chunks) - chunk_index) + 1):
            part = chunks[chunk_index + chunk_count - 1]
            part_start = float(part.get("start", 0.0) or 0.0)
            if chunk_count > 1 and part_start - combined_end > 1.05:
                break

            combined_text = " ".join(value for value in (combined_text, str(part.get("text", ""))) if value)
            combined_words.extend(part.get("words") or [])
            combined_end = max(combined_end, float(part.get("end", combined_end) or combined_end))

            group = choose_chunk_group(lines, line_norms, cursor, combined_text)
            if not group and (last_assigned_time is None or chunk_start - last_assigned_time >= 8.0):
                group = choose_chunk_group(
                    lines,
                    line_norms,
                    cursor,
                    combined_text,
                    max_lookahead=9 if last_assigned_time is None else 7,
                    max_lines=7,
                    skip_penalty=0.055
                )
            if group:
                choices.append((group["score"] - (chunk_count - 1) * 0.012, chunk_count, group, {
                    "start": chunk_start,
                    "end": combined_end,
                    "text": combined_text,
                    "words": list(combined_words)
                }))

        if not choices:
            chunk_index += 1
            continue

        _, consumed_chunks, group, selected_chunk = max(
            choices,
            key=lambda item: (item[0], item[2]["source_coverage"], -item[1])
        )
        assign_chunk_to_lines(timeline, lines, selected_chunk, group)
        for offset in range(group["count"]):
            timeline[group["start_index"] + offset]["source"] = "segment"
        cursor = group["start_index"] + group["count"]
        matched_lines += group["count"]
        last_assigned_time = chunk_start
        chunk_index += consumed_chunks

    fill_missing_lines(timeline, duration)
    return timeline, matched_lines


def alignment_selection_score(lines, timeline, matched_lines):
    matched_ratio = matched_lines / max(1, len(lines))
    measured = [row for row in timeline if float(row.get("confidence", 0.0) or 0.0) >= 0.35]
    average_confidence = (
        sum(float(row.get("confidence", 0.0) or 0.0) for row in measured) / len(measured)
        if measured else 0.0
    )
    return matched_ratio * 0.82 + average_confidence * 0.18


def align_lines_to_transcript(lines, chunks, duration):
    global_timeline, global_matched = align_lines_global(lines, chunks, duration)
    greedy_timeline, greedy_matched = align_lines_greedy(lines, chunks, duration)
    choices = [
        (alignment_selection_score(lines, global_timeline, global_matched), global_matched, global_timeline, "global-anchors"),
        (alignment_selection_score(lines, greedy_timeline, greedy_matched), greedy_matched, greedy_timeline, "segment-sequence")
    ]
    _, matched_lines, timeline, method = max(choices, key=lambda item: (item[0], item[1]))
    return timeline, matched_lines, method


def fill_missing_lines(timeline, duration):
    if not timeline:
        return

    known = [row for row in timeline if math.isfinite(row["start"])]
    if not known:
        span = max(1.0, duration)
        step = span / len(timeline)
        for index, row in enumerate(timeline):
            row["start"] = index * step
            row["end"] = min(duration, (index + 1) * step)
            row["confidence"] = 0.2
        return

    known_gaps = [
        known[index + 1]["start"] - known[index]["start"]
        for index in range(len(known) - 1)
        if 0.75 <= known[index + 1]["start"] - known[index]["start"] <= 8.5
    ]
    typical_gap = sorted(known_gaps)[len(known_gaps) // 2] if known_gaps else 3.2
    typical_gap = max(2.4, min(4.8, typical_gap))

    first_known = known[0]
    for index in range(0, first_known["index"]):
        distance = first_known["index"] - index
        timeline[index]["start"] = max(0.0, first_known["start"] - distance * typical_gap)
        timeline[index]["confidence"] = 0.28

    last_known = known[-1]
    for index in range(last_known["index"] + 1, len(timeline)):
        distance = index - last_known["index"]
        timeline[index]["start"] = min(duration, last_known["start"] + distance * typical_gap)
        timeline[index]["confidence"] = 0.28

    previous_known = None
    for row in timeline:
        if math.isfinite(row["start"]):
            if previous_known and row["index"] > previous_known["index"] + 1:
                gap = row["index"] - previous_known["index"]
                start_gap = row["start"] - previous_known["start"]
                for inner_index in range(previous_known["index"] + 1, row["index"]):
                    position = (inner_index - previous_known["index"]) / gap
                    timeline[inner_index]["start"] = previous_known["start"] + start_gap * position
                    timeline[inner_index]["confidence"] = 0.3
            previous_known = row

    for index, row in enumerate(timeline):
        if not math.isfinite(row["end"]):
            next_start = timeline[index + 1]["start"] if index + 1 < len(timeline) else duration
            row["end"] = max(row["start"] + 0.35, next_start - 0.05)

    for index, row in enumerate(timeline):
        next_row = timeline[index + 1] if index + 1 < len(timeline) else None
        if next_row and next_row["start"] <= row["start"] + 0.15:
            next_row["start"] = row["start"] + 0.15
        row["end"] = max(row["start"] + 0.35, row["end"])
        if next_row:
            row["end"] = min(row["end"], max(row["start"] + 0.35, next_row["start"] - 0.05))
        if duration:
            row["start"] = max(0.0, min(float(duration), row["start"]))
            row["end"] = max(row["start"] + 0.1, min(float(duration), row["end"]))
        row["start"] = round(row["start"], 3)
        row["end"] = round(row["end"], 3)
        row["confidence"] = round(float(row["confidence"]), 3)


def load_faster_whisper_model(model_name, force_cpu=False):
    configure_cuda_runtime()
    from faster_whisper import WhisperModel

    model_path = resolve_model_path(model_name) or model_name
    if not force_cpu and os.environ.get("OBS_KARAOKE_FORCE_CPU") != "1":
        try:
            return WhisperModel(model_path, device="cuda", compute_type="int8_float16"), "cuda"
        except Exception:
            pass
    return WhisperModel(model_path, device="cpu", compute_type="int8"), "cpu"


def transcribe_with_faster_whisper(
    audio_path,
    model_name,
    prompt_text="",
    language_hint=None,
    model=None,
    inference_device=None,
    clip_timestamps=None,
    condition_on_previous_text=True
):
    if model is None:
        model, inference_device = load_faster_whisper_model(model_name)

    def run(active_model):
        options = {
            "language": language_hint,
            "beam_size": 5,
            "vad_filter": False,
            "initial_prompt": prompt_text[:1800] if prompt_text else None,
            "word_timestamps": True,
            "condition_on_previous_text": condition_on_previous_text
        }
        if clip_timestamps:
            options["clip_timestamps"] = clip_timestamps
            options["condition_on_previous_text"] = False
        segments, info = active_model.transcribe(audio_path, **options)
        chunks = []
        word_count = 0
        for segment in segments:
            words = []
            for word in segment.words or []:
                words.append({
                    "text": str(word.word).strip(),
                    "start": float(word.start),
                    "end": float(word.end),
                    "probability": float(getattr(word, "probability", 0.45) or 0.45)
                })
            word_count += len(words)
            chunks.append({
                "start": float(segment.start),
                "end": float(segment.end),
                "text": segment.text.strip(),
                "words": words
            })
        return chunks, float(getattr(info, "duration", 0.0) or 0.0), word_count

    try:
        chunks, duration, word_count = run(model)
    except Exception:
        if inference_device != "cuda":
            raise
        model, inference_device = load_faster_whisper_model(model_name, force_cpu=True)
        chunks, duration, word_count = run(model)

    return chunks, duration, f"faster-whisper-{inference_device}", word_count, model, inference_device


def transcribe_with_classic_whisper(audio_path, model_name, prompt_text="", language_hint=None):
    import whisper

    model = whisper.load_model(model_name)
    result = model.transcribe(
        audio_path,
        fp16=False,
        verbose=False,
        language=language_hint,
        initial_prompt=prompt_text[:1800] if prompt_text else None
    )
    chunks = []
    for segment in result.get("segments", []):
        chunks.append({
            "start": float(segment.get("start", 0.0) or 0.0),
            "end": float(segment.get("end", 0.0) or 0.0),
            "text": str(segment.get("text", "")).strip()
        })
    duration = chunks[-1]["end"] if chunks else 0.0
    return chunks, duration, "openai-whisper"


def merge_candidate_timelines(lines, candidates, best):
    if len(candidates) < 2 or not best.get("timeline"):
        return best

    merged = [dict(row) for row in best["timeline"]]
    rescued = 0
    for index, row in enumerate(merged):
        if float(row.get("confidence", 0.0) or 0.0) >= 0.35:
            continue

        previous_start = None
        previous_index = None
        for previous_index in range(index - 1, -1, -1):
            previous = merged[previous_index]
            if float(previous.get("confidence", 0.0) or 0.0) >= 0.35:
                previous_start = float(previous["start"])
                break

        next_start = None
        next_index = None
        for next_index in range(index + 1, len(merged)):
            following = merged[next_index]
            if float(following.get("confidence", 0.0) or 0.0) >= 0.35:
                next_start = float(following["start"])
                break

        alternatives = []
        for candidate in candidates:
            if candidate is best or index >= len(candidate.get("timeline", [])):
                continue
            alternate = candidate["timeline"][index]
            confidence = float(alternate.get("confidence", 0.0) or 0.0)
            start = float(alternate.get("start", 0.0) or 0.0)
            if confidence < 0.45:
                continue
            if previous_start is not None and start <= previous_start + 0.05:
                continue
            if next_start is not None and start >= next_start - 0.05:
                continue
            if previous_start is not None and start - previous_start < minimum_start_span(merged, previous_index, index):
                continue
            if next_start is not None and next_start - start < minimum_start_span(merged, index, next_index):
                continue
            alternatives.append(alternate)

        if not alternatives:
            continue
        alternate = max(alternatives, key=lambda item: float(item.get("confidence", 0.0) or 0.0))
        merged[index] = dict(alternate)
        merged[index]["source"] = f"candidate-{alternate.get('source', 'measured')}"
        rescued += 1

    if not rescued:
        return best

    prune_impossible_anchor_spacing(merged)
    refill_low_confidence_lines(merged, float(best.get("duration", 0.0) or 0.0))

    for index, row in enumerate(merged):
        next_row = merged[index + 1] if index + 1 < len(merged) else None
        if next_row:
            row["end"] = min(
                max(float(row["start"]) + 0.1, float(row["end"])),
                max(float(row["start"]) + 0.1, float(next_row["start"]) - 0.05)
            )
        row["start"] = round(float(row["start"]), 3)
        row["end"] = round(float(row["end"]), 3)

    matched_lines = sum(1 for row in merged if float(row.get("confidence", 0.0) or 0.0) >= 0.35)
    combined = dict(best)
    combined["timeline"] = merged
    combined["matchedLines"] = matched_lines
    combined["quality"] = timeline_quality_score(lines, merged, matched_lines)
    combined["alignmentMethod"] = f"{best['alignmentMethod']}+candidate-rescue"
    return combined


def find_low_confidence_runs(timeline, threshold=0.35):
    runs = []
    start = None
    for index, row in enumerate(timeline):
        low = float(row.get("confidence", 0.0) or 0.0) < threshold
        if low and start is None:
            start = index
        elif not low and start is not None:
            runs.append((start, index - 1))
            start = None
    if start is not None:
        runs.append((start, len(timeline) - 1))
    return runs


def refill_low_confidence_lines(timeline, duration, threshold=0.35):
    for row in timeline:
        if float(row.get("confidence", 0.0) or 0.0) >= threshold:
            continue
        row["start"] = math.nan
        row["end"] = math.nan
    fill_missing_lines(timeline, duration)


def forced_alignment_window(audio, sampling_rate, lines, window_start, window_end, faster_model, language):
    from faster_whisper.audio import pad_or_trim
    from faster_whisper.tokenizer import Tokenizer

    sample_start = max(0, int(window_start * sampling_rate))
    sample_end = min(len(audio), int(window_end * sampling_rate))
    if sample_end - sample_start < sampling_rate // 2:
        return []

    segment = audio[sample_start:sample_end]
    features = faster_model.feature_extractor(segment)
    features = pad_or_trim(features, faster_model.feature_extractor.nb_max_frames)
    encoder = faster_model.encode(features)
    tokenizer = Tokenizer(
        faster_model.hf_tokenizer,
        faster_model.model.is_multilingual,
        task="transcribe",
        language=language or "ko"
    )

    line_tokens = [tokenizer.encode(" " + line.strip()) for line in lines]
    combined_tokens = [token for tokens in line_tokens for token in tokens]
    if not combined_tokens or len(combined_tokens) >= faster_model.max_length - 8:
        return []

    content_frames = min(
        faster_model.feature_extractor.nb_max_frames,
        max(1, round((sample_end - sample_start) / sampling_rate * faster_model.frames_per_second))
    )
    alignment = faster_model.find_alignment(
        tokenizer,
        [combined_tokens],
        encoder,
        content_frames
    )[0]

    token_ends = []
    token_cursor = 0
    for tokens in line_tokens:
        token_cursor += len(tokens)
        token_ends.append(token_cursor)

    grouped = [[] for _ in lines]
    token_cursor = 0
    line_index = 0
    for word in alignment:
        while line_index < len(token_ends) - 1 and token_cursor >= token_ends[line_index]:
            line_index += 1
        grouped[line_index].append(word)
        token_cursor += len(word.get("tokens") or [])

    rows = []
    for index, (line, words) in enumerate(zip(lines, grouped)):
        if not words:
            rows.append(None)
            continue
        first = words[0]
        last = words[-1]
        first_start = float(first.get("start", 0.0) or 0.0)
        first_end = float(first.get("end", first_start) or first_start)
        if first_end - first_start > 3.0:
            first_start = max(first_start, first_end - 1.4)
        start = window_start + first_start
        end = max(start + 0.1, window_start + float(last.get("end", first_end) or first_end))
        probabilities = [float(word.get("probability", 0.0) or 0.0) for word in words]
        word_rows = [
            {
                "text": str(word.get("word", "")).strip(),
                "start": window_start + float(word.get("start", 0.0) or 0.0),
                "end": window_start + float(word.get("end", 0.0) or 0.0),
                "probability": float(word.get("probability", 0.0) or 0.0)
            }
            for word in words
        ]
        if word_rows:
            word_rows[0]["start"] = start
        rows.append({
            "text": line,
            "start": start,
            "end": end,
            "confidence": max(0.7, min(0.9, 0.68 + sum(probabilities) / max(1, len(probabilities)) * 0.25)),
            "source": "forced-text",
            "words": word_rows
        })
    return rows


def force_align_low_confidence_windows(
    audio_path,
    lines,
    best,
    faster_model,
    threshold=0.7,
    max_windows=6
):
    from faster_whisper.audio import decode_audio

    timeline = [dict(row) for row in best.get("timeline", [])]
    if not timeline or faster_model is None:
        return best, 0, []

    sampling_rate = faster_model.feature_extractor.sampling_rate
    audio = decode_audio(audio_path, sampling_rate=sampling_rate)
    forced_count = 0
    forced_chunks = []

    for run_start, run_end in find_low_confidence_runs(timeline, threshold=threshold)[:max_windows]:
        context_start = max(0, run_start - 1)
        context_end = min(len(lines) - 1, run_end + 1)
        previous = timeline[context_start - 1] if context_start > 0 else None
        following = timeline[context_end + 1] if context_end + 1 < len(timeline) else None

        if previous:
            window_start = max(0.0, float(previous["start"]) - 0.8)
        elif following:
            estimated_span = min(29.0, max(10.0, (context_end + 2) * 2.65))
            window_start = max(0.0, float(following["start"]) - estimated_span)
        else:
            window_start = max(0.0, float(timeline[context_start]["start"]) - 4.0)

        if following:
            window_end = min(float(best.get("duration", 0.0) or 0.0), float(following["start"]) + 1.8)
        elif previous:
            estimated_span = min(29.0, max(10.0, (len(lines) - context_start + 1) * 2.65))
            window_end = min(float(best.get("duration", 0.0) or 0.0), window_start + estimated_span)
        else:
            window_end = min(float(best.get("duration", 0.0) or 0.0), window_start + 29.0)

        if window_end - window_start > 29.5:
            if previous:
                window_end = window_start + 29.5
            else:
                window_start = max(0.0, window_end - 29.5)
        if window_end - window_start < 1.0:
            continue

        context_lines = lines[context_start:context_end + 1]
        forced_rows = forced_alignment_window(
            audio,
            sampling_rate,
            context_lines,
            window_start,
            window_end,
            faster_model,
            "ko" if has_hangul_lyrics(context_lines) else detect_language_hint(context_lines)
        )
        if not forced_rows:
            continue

        for offset, forced_row in enumerate(forced_rows):
            target_index = context_start + offset
            inside_run = run_start <= target_index <= run_end
            weak_context = float(timeline[target_index].get("confidence", 0.0) or 0.0) < 0.86
            if forced_row is None or not (inside_run or weak_context):
                continue
            start = float(forced_row["start"])
            if start < window_start - 0.05 or start > window_end + 0.05:
                continue
            timeline[target_index] = {
                **timeline[target_index],
                "start": start,
                "end": float(forced_row["end"]),
                "confidence": float(forced_row["confidence"]),
                "source": "forced-text"
            }
            forced_chunks.append({
                "start": start,
                "end": float(forced_row["end"]),
                "text": forced_row["text"],
                "words": forced_row["words"],
                "source": "forced-text"
            })
            forced_count += 1

    if not forced_count:
        return best, 0, []

    prune_impossible_anchor_spacing(timeline)
    refill_low_confidence_lines(timeline, float(best.get("duration", 0.0) or 0.0))
    matched_lines = sum(1 for row in timeline if float(row.get("confidence", 0.0) or 0.0) >= 0.35)
    forced = dict(best)
    forced["timeline"] = timeline
    forced["matchedLines"] = matched_lines
    forced["quality"] = timeline_quality_score(lines, timeline, matched_lines)
    forced["alignmentMethod"] = f"{best['alignmentMethod']}+forced-text"
    return forced, forced_count, forced_chunks


def find_consecutive_repeated_runs(lines, minimum_repeats=3):
    keys = [comparison_text(line) for line in lines]
    runs = []
    index = 0
    while index < len(lines):
        key = keys[index]
        if len(key) < 6:
            index += 1
            continue

        end = index + 1
        while end < len(lines) and keys[end] == key:
            end += 1

        repeat_count = end - index
        if repeat_count < minimum_repeats:
            index += 1
            continue

        decorated_end = end
        if end < len(lines):
            candidate = keys[end]
            maximum_length = max(len(key) + 12, round(len(key) * 2.2))
            if candidate.startswith(key) and key != candidate and len(candidate) <= maximum_length:
                decorated_end += 1

        runs.append({
            "start": index,
            "end": decorated_end - 1,
            "base": key,
            "exactRepeats": repeat_count
        })
        index = decorated_end

    return runs


def repeated_line_step(timeline, runs):
    gaps = []
    for run in runs:
        for index in range(run["start"], run["end"]):
            left = float(timeline[index].get("start", math.nan))
            right = float(timeline[index + 1].get("start", math.nan))
            gap = right - left
            if math.isfinite(gap) and 0.65 <= gap <= 5.2:
                gaps.append(gap)

    if not gaps:
        return 2.35
    gaps.sort()
    return max(0.9, min(4.8, gaps[len(gaps) // 2]))


def repeated_phrase_candidate_starts(base_line, chunks):
    lyric_words, _ = flatten_lyric_words([base_line])
    lyric_words = [word for word in lyric_words if word.get("norm")]
    transcript_words = flatten_transcript_words([
        chunk for chunk in chunks if chunk.get("source") != "forced-text"
    ])
    count = len(lyric_words)
    if count < 2 or len(transcript_words) < count:
        return []

    candidates = []
    for start in range(0, len(transcript_words) - count + 1):
        similarities = [
            word_similarity(lyric_words[offset]["text"], transcript_words[start + offset]["text"])
            for offset in range(count)
        ]
        strong_words = sum(1 for score in similarities if score >= 0.55)
        average = sum(similarities) / count
        if strong_words < min(2, count) or average < 0.5:
            continue
        candidates.append(float(transcript_words[start]["start"]))
    return candidates


def regularize_repeated_rows(rows, candidate_starts, typical_step):
    if len(rows) < 2:
        return rows

    first_guess = float(rows[0]["start"])
    last_candidate = first_guess + typical_step * (len(rows) - 1) + typical_step * 0.9
    phases = []
    for candidate_start in candidate_starts:
        if candidate_start < first_guess - typical_step or candidate_start > last_candidate:
            continue
        offset = round((candidate_start - first_guess) / typical_step)
        if offset < 0 or offset >= len(rows):
            continue
        phase = candidate_start - offset * typical_step
        if abs(phase - first_guess) <= typical_step * 0.8:
            phases.append(phase)

    regular_start = min(phases, key=lambda phase: abs(phase - first_guess)) if phases else first_guess
    adjusted = []
    for offset, row in enumerate(rows):
        expected = regular_start + typical_step * offset
        measured = float(row["start"])
        if offset == 0:
            start = regular_start
        elif abs(measured - expected) <= typical_step * 0.22:
            start = measured * 0.55 + expected * 0.45
        else:
            start = expected
        adjusted.append({**row, "start": start})

    for index, row in enumerate(adjusted[:-1]):
        row["end"] = min(float(row["end"]), float(adjusted[index + 1]["start"]) - 0.05)
        row["end"] = max(float(row["start"]) + 0.1, float(row["end"]))
    return adjusted


def force_align_repeated_runs(
    audio_path,
    lines,
    best,
    faster_model,
    max_runs=8
):
    from faster_whisper.audio import decode_audio

    timeline = [dict(row) for row in best.get("timeline", [])]
    runs = find_consecutive_repeated_runs(lines)
    if not timeline or not runs or faster_model is None:
        return best, 0, []

    sampling_rate = faster_model.feature_extractor.sampling_rate
    audio = decode_audio(audio_path, sampling_rate=sampling_rate)
    duration = float(best.get("duration", 0.0) or 0.0)
    typical_step = repeated_line_step(timeline, runs)
    repeated_indexes = {
        index
        for run in runs
        for index in range(run["start"], run["end"] + 1)
    }
    forced_count = 0
    forced_chunks = []
    phrase_candidates = {}

    for run in runs[:max_runs]:
        run_start = int(run["start"])
        run_end = int(run["end"])
        run_count = run_end - run_start + 1

        previous_index = run_start - 1 if run_start > 0 and run_start - 1 not in repeated_indexes else None
        following_index = (
            run_end + 1
            if run_end + 1 < len(lines) and run_end + 1 not in repeated_indexes
            else None
        )
        previous = timeline[previous_index] if previous_index is not None else None
        following = timeline[following_index] if following_index is not None else None
        previous_ready = previous is not None and math.isfinite(float(previous.get("start", math.nan)))
        following_ready = following is not None and math.isfinite(float(following.get("start", math.nan)))

        expected_span = typical_step * run_count
        if previous_ready:
            window_start = max(0.0, float(previous["start"]) - 0.8)
        elif following_ready:
            window_start = max(0.0, float(following["start"]) - expected_span - 5.5)
        else:
            window_start = max(0.0, float(timeline[run_start].get("start", 0.0) or 0.0) - 1.2)

        if following_ready:
            window_end = min(duration, float(following.get("end", following["start"])) + 0.8)
        elif previous_ready:
            window_end = min(duration, window_start + expected_span + 5.5)
        else:
            window_end = min(
                duration,
                max(window_start + expected_span + 3.0, float(timeline[run_end].get("end", 0.0) or 0.0) + 1.2)
            )

        if window_end - window_start > 29.5:
            if previous_ready and not following_ready:
                window_end = window_start + 29.5
            elif following_ready and not previous_ready:
                window_start = max(0.0, window_end - 29.5)
            else:
                current_start = float(timeline[run_start].get("start", 0.0) or 0.0)
                anchor_midpoint = (float(previous["start"]) + float(following["start"])) / 2.0
                if current_start <= anchor_midpoint:
                    following_ready = False
                    following_index = None
                    window_end = min(duration, window_start + min(29.5, expected_span + 5.5))
                else:
                    previous_ready = False
                    previous_index = None
                    window_start = max(0.0, window_end - min(29.5, expected_span + 5.5))
        if window_end - window_start < max(4.0, typical_step * run_count * 0.6):
            continue

        context_start = previous_index if previous_ready else run_start
        context_end = following_index if following_ready else run_end
        context_lines = lines[context_start:context_end + 1]
        forced_rows = forced_alignment_window(
            audio,
            sampling_rate,
            context_lines,
            window_start,
            window_end,
            faster_model,
            detect_language_hint(context_lines)
        )
        run_offset = run_start - context_start
        selected = forced_rows[run_offset:run_offset + run_count]
        if len(selected) != run_count or any(row is None for row in selected):
            continue

        starts = [float(row["start"]) for row in selected]
        gaps = [right - left for left, right in zip(starts, starts[1:])]
        if any(gap < 0.35 or gap > max(6.0, typical_step * 2.7) for gap in gaps):
            continue

        base_key = run["base"]
        if base_key not in phrase_candidates:
            phrase_candidates[base_key] = repeated_phrase_candidate_starts(
                lines[run_start],
                best.get("chunks", [])
            )
        selected = regularize_repeated_rows(
            selected,
            phrase_candidates[base_key],
            typical_step
        )

        for offset, forced_row in enumerate(selected):
            target_index = run_start + offset
            timeline[target_index] = {
                **timeline[target_index],
                "start": float(forced_row["start"]),
                "end": float(forced_row["end"]),
                "confidence": float(forced_row["confidence"]),
                "source": "forced-repeat"
            }
            forced_chunks.append({
                "start": float(forced_row["start"]),
                "end": float(forced_row["end"]),
                "text": forced_row["text"],
                "words": forced_row["words"],
                "source": "forced-text"
            })
            forced_count += 1

    if not forced_count:
        return best, 0, []

    for index, row in enumerate(timeline):
        next_row = timeline[index + 1] if index + 1 < len(timeline) else None
        if next_row:
            row["end"] = min(
                max(float(row["start"]) + 0.1, float(row.get("end", row["start"] + 0.1) or row["start"] + 0.1)),
                max(float(row["start"]) + 0.1, float(next_row["start"]) - 0.05)
            )
        row["start"] = round(float(row["start"]), 3)
        row["end"] = round(float(row["end"]), 3)

    aligned = dict(best)
    aligned["timeline"] = timeline
    aligned["matchedLines"] = sum(
        1 for row in timeline if float(row.get("confidence", 0.0) or 0.0) >= 0.35
    )
    aligned["quality"] = timeline_quality_score(lines, timeline, aligned["matchedLines"])
    aligned["alignmentMethod"] = f"{best['alignmentMethod']}+forced-repeat"
    return aligned, forced_count, forced_chunks


def refine_repeated_patterns(timeline):
    refined = 0
    strong_by_text = {}
    for row in timeline:
        if float(row.get("confidence", 0.0) or 0.0) < 0.6:
            continue
        key = normalized_text(row.get("text", ""))
        if key:
            strong_by_text.setdefault(key, []).append(row)

    for index, row in enumerate(timeline):
        if float(row.get("confidence", 0.0) or 0.0) >= 0.35:
            continue
        references = strong_by_text.get(normalized_text(row.get("text", "")), [])
        durations = [
            float(reference.get("end", reference["start"])) - float(reference["start"])
            for reference in references
            if 0.35 <= float(reference.get("end", reference["start"])) - float(reference["start"]) <= 8.0
        ]
        if not durations:
            continue

        duration = sorted(durations)[len(durations) // 2]
        previous = timeline[index - 1] if index > 0 else None
        following = timeline[index + 1] if index + 1 < len(timeline) else None
        if following and float(following.get("confidence", 0.0) or 0.0) >= 0.35:
            end = float(following["start"]) - 0.05
            start = end - duration
        elif previous and float(previous.get("confidence", 0.0) or 0.0) >= 0.35:
            start = float(previous.get("end", previous["start"])) + 0.05
            end = start + duration
        else:
            continue

        if previous and start <= float(previous["start"]) + minimum_line_spacing(previous.get("text", "")):
            continue
        if following and end >= float(following["start"]):
            continue

        row["start"] = start
        row["end"] = end
        row["confidence"] = 0.56
        row["source"] = "repeated-duration"
        refined += 1

    anchors_by_text = {}
    for row in timeline:
        if float(row.get("confidence", 0.0) or 0.0) < 0.6:
            continue
        key = normalized_text(row.get("text", ""))
        if key:
            anchors_by_text.setdefault(key, []).append(row)

    for anchors in anchors_by_text.values():
        for left, right in zip(anchors, anchors[1:]):
            line_gap = int(right["index"]) - int(left["index"])
            time_gap = float(right["start"]) - float(left["start"])
            if line_gap < 2 or line_gap > 8 or time_gap / line_gap < 0.45 or time_gap / line_gap > 4.0:
                continue

            step = time_gap / line_gap
            pattern_matches = True
            for offset in range(1, line_gap):
                inner = timeline[int(left["index"]) + offset]
                if float(inner.get("confidence", 0.0) or 0.0) >= 0.35:
                    continue
                repeated_elsewhere = any(
                    normalized_text(other.get("text", "")) == normalized_text(inner.get("text", ""))
                    and float(other.get("confidence", 0.0) or 0.0) >= 0.6
                    for other in timeline
                )
                if not repeated_elsewhere:
                    pattern_matches = False
                    break
            if not pattern_matches:
                continue

            for offset in range(1, line_gap):
                inner = timeline[int(left["index"]) + offset]
                if float(inner.get("confidence", 0.0) or 0.0) >= 0.35:
                    continue
                inner["start"] = float(left["start"]) + step * offset
                inner["confidence"] = 0.58
                inner["source"] = "repeated-pattern"
                refined += 1

            for offset in range(1, line_gap):
                target_index = int(right["index"]) + offset
                pattern_index = int(left["index"]) + offset
                if target_index >= len(timeline) or pattern_index >= len(timeline):
                    break
                target = timeline[target_index]
                pattern = timeline[pattern_index]
                if float(target.get("confidence", 0.0) or 0.0) >= 0.35:
                    break
                if normalized_text(target.get("text", "")) != normalized_text(pattern.get("text", "")):
                    break
                target["start"] = float(right["start"]) + step * offset
                target["end"] = target["start"] + step * 0.92
                target["confidence"] = 0.55
                target["source"] = "repeated-pattern"
                refined += 1

    if not refined:
        return 0

    for index, row in enumerate(timeline):
        next_row = timeline[index + 1] if index + 1 < len(timeline) else None
        if next_row:
            row["end"] = min(
                max(float(row["start"]) + 0.1, float(row.get("end", row["start"] + 0.1) or row["start"] + 0.1)),
                max(float(row["start"]) + 0.1, float(next_row["start"]) - 0.05)
            )
        row["start"] = round(float(row["start"]), 3)
        row["end"] = round(float(row["end"]), 3)
    return refined


def rescue_alignment_windows(
    audio_path,
    lines,
    best,
    model_name,
    faster_model,
    inference_device,
    max_windows=5
):
    timeline = [dict(row) for row in best.get("timeline", [])]
    if not timeline:
        return best, faster_model, inference_device, 0, 0

    rescued_lines = 0
    extra_words = 0
    for run_start, run_end in find_low_confidence_runs(timeline)[:max_windows]:
        run_lines = lines[run_start:run_end + 1]
        previous = timeline[run_start - 1] if run_start > 0 else None
        following = timeline[run_end + 1] if run_end + 1 < len(timeline) else None
        window_start = max(
            0.0,
            float(previous["end"]) - 0.45 if previous else float(timeline[run_start]["start"]) - 1.0
        )
        window_end = min(
            float(best.get("duration", 0.0) or 0.0),
            float(following["start"]) + 0.45 if following else float(timeline[run_end]["end"]) + 1.0
        )
        if window_end - window_start < 0.8 or window_end - window_start > 35.0:
            continue

        prompt = "\n".join(run_lines)
        language = detect_language_hint(run_lines)
        chunks, _, _, word_count, faster_model, inference_device = transcribe_with_faster_whisper(
            audio_path,
            model_name,
            prompt,
            language,
            faster_model,
            inference_device,
            [window_start, window_end]
        )
        extra_words += word_count
        if not chunks:
            continue

        local_timeline, _, local_method = align_lines_to_transcript(run_lines, chunks, window_end)
        for offset, local_row in enumerate(local_timeline):
            confidence = float(local_row.get("confidence", 0.0) or 0.0)
            start = float(local_row.get("start", 0.0) or 0.0)
            if confidence < 0.38:
                continue
            if start < window_start - 0.5 or start > window_end + 0.5:
                continue
            if previous and start <= float(previous["start"]) + 0.05:
                continue
            if following and start >= float(following["start"]) - 0.05:
                continue
            target_index = run_start + offset
            timeline[target_index] = dict(local_row)
            timeline[target_index]["id"] = f"line-{target_index + 1}"
            timeline[target_index]["index"] = target_index
            timeline[target_index]["text"] = lines[target_index]
            timeline[target_index]["source"] = f"window-{local_method}"
            rescued_lines += 1

    if not rescued_lines:
        return best, faster_model, inference_device, 0, extra_words

    prune_impossible_anchor_spacing(timeline)
    refill_low_confidence_lines(timeline, float(best.get("duration", 0.0) or 0.0))
    for index, row in enumerate(timeline):
        next_row = timeline[index + 1] if index + 1 < len(timeline) else None
        if next_row:
            row["end"] = min(
                max(float(row["start"]) + 0.1, float(row["end"])),
                max(float(row["start"]) + 0.1, float(next_row["start"]) - 0.05)
            )
        row["start"] = round(float(row["start"]), 3)
        row["end"] = round(float(row["end"]), 3)

    matched_lines = sum(1 for row in timeline if float(row.get("confidence", 0.0) or 0.0) >= 0.35)
    rescued = dict(best)
    rescued["timeline"] = timeline
    rescued["matchedLines"] = matched_lines
    rescued["quality"] = timeline_quality_score(lines, timeline, matched_lines)
    rescued["alignmentMethod"] = f"{best['alignmentMethod']}+window-rescue"
    return rescued, faster_model, inference_device, rescued_lines, extra_words


def run_alignment(audio_path, lyrics_path, model_name):
    input_lines = read_lyrics(lyrics_path)
    lines = list(input_lines)
    if not lines:
        respond({"ok": False, "error": "Lyrics file is empty."})
        return

    local_model = resolve_model_path(model_name)
    if not local_model:
        respond({
            "ok": False,
            "code": "MODEL_NOT_INSTALLED",
            "error": f"Local {model_name} model files are not included.",
            "install": "Run install-turbo-model.bat, then restart the app."
        })
        return

    prompt_text = "\n".join(lines)
    language_hint = detect_language_hint(lines)

    faster_available = module_available("faster_whisper")
    classic_available = module_available("whisper")
    if not faster_available and not classic_available:
        respond({
            "ok": False,
            "code": "MODEL_NOT_INSTALLED",
            "error": f"{model_name} model package is not installed.",
            "install": "Run install-turbo-model.bat, then restart the app."
        })
        return

    specs = []
    if language_hint:
        specs.append((language_hint, "", f"{language_hint}+independent", False))
        specs.append((language_hint, prompt_text, f"{language_hint}+prompt", language_hint != "ja"))
        if language_hint != "ja":
            specs.append((language_hint, "", f"{language_hint}+no-prompt", True))
    elif has_hangul_lyrics(lines):
        specs.append((None, "", "auto+independent", False))
        specs.append((None, prompt_text, "auto+prompt", True))
        specs.append(("ko", prompt_text, "ko+prompt-independent", False))
    else:
        specs.append((None, "", "auto+independent", False))
        specs.append((None, prompt_text, "auto+prompt", True))

    candidates = []
    engine = "faster-whisper" if faster_available else "openai-whisper"
    word_count = 0
    inference_device = "cpu"
    faster_model = None
    compatibility = None
    auto_segmentation = {
        "applied": False,
        "originalLines": len(input_lines),
        "resultLines": len(input_lines),
        "longLines": 0,
        "audioGuidedBoundaries": 0
    }
    auto_segmentation_pending = lyrics_need_auto_segmentation(lines)

    if faster_available:
        faster_model, inference_device = load_faster_whisper_model(model_name)

    for candidate_language, candidate_prompt, label, condition_previous in specs:
        if faster_available:
            chunks, duration, engine, word_count, faster_model, inference_device = transcribe_with_faster_whisper(
                audio_path,
                model_name,
                candidate_prompt,
                candidate_language,
                faster_model,
                inference_device,
                condition_on_previous_text=condition_previous
            )
        else:
            chunks, duration, engine = transcribe_with_classic_whisper(
                audio_path,
                model_name,
                candidate_prompt,
                candidate_language
            )
            word_count = 0

        if auto_segmentation_pending:
            lines, auto_segmentation = auto_segment_lyrics(lines, chunks)
            auto_segmentation_pending = False

        candidate = build_alignment_candidate(label, lines, chunks, duration)
        candidates.append(candidate)

        if not candidate_prompt and not label.endswith("+no-prompt") and compatibility is None:
            compatibility = assess_lyrics_compatibility(lines, candidate)
            if compatibility["status"] in ("mismatch", "insufficient-vocals"):
                code = (
                    "LYRICS_AUDIO_MISMATCH"
                    if compatibility["status"] == "mismatch"
                    else "VOCAL_NOT_DETECTED"
                )
                respond({
                    "ok": False,
                    "code": code,
                    "error": compatibility["reason"],
                    "model": model_name,
                    "device": inference_device,
                    "compatibility": compatibility
                })
                return

        matched_ratio = candidate["matchedLines"] / max(1, len(lines))
        if candidate["quality"] >= 0.88 and matched_ratio >= 0.98:
            break

    def candidate_sort_key(item):
        matched_ratio = item["matchedLines"] / max(1, len(lines))
        if language_hint == "ja":
            return (
                item["quality"],
                item.get("transcriptHealth", 0.0),
                matched_ratio,
                item["label"].endswith("+independent")
            )
        return (
            matched_ratio,
            item.get("transcriptHealth", 0.0),
            item["quality"]
        )

    best = max(candidates, key=candidate_sort_key) if candidates else {
        "label": "none",
        "alignmentMethod": "none",
        "chunks": [],
        "duration": 0.0,
        "timeline": [],
        "matchedLines": 0,
        "quality": 0.0
    }
    best = merge_candidate_timelines(lines, candidates, best)

    rescued_lines = 0
    if faster_available and best.get("matchedLines", 0) < len(lines):
        best, faster_model, inference_device, rescued_lines, rescue_word_count = rescue_alignment_windows(
            audio_path,
            lines,
            best,
            model_name,
            faster_model,
            inference_device
        )
        word_count += rescue_word_count

    forced_lines = 0
    if faster_available and language_hint != "ja":
        best, forced_lines, forced_chunks = force_align_low_confidence_windows(
            audio_path,
            lines,
            best,
            faster_model
        )
        if forced_chunks:
            best["chunks"] = sorted(
                list(best.get("chunks", [])) + forced_chunks,
                key=lambda chunk: (float(chunk.get("start", 0.0) or 0.0), float(chunk.get("end", 0.0) or 0.0))
            )
            word_count += sum(len(chunk.get("words") or []) for chunk in forced_chunks)

    forced_repeated_lines = 0
    if faster_available:
        best, forced_repeated_lines, repeated_chunks = force_align_repeated_runs(
            audio_path,
            lines,
            best,
            faster_model
        )
        if repeated_chunks:
            best["chunks"] = sorted(
                list(best.get("chunks", [])) + repeated_chunks,
                key=lambda chunk: (float(chunk.get("start", 0.0) or 0.0), float(chunk.get("end", 0.0) or 0.0))
            )
            word_count += sum(len(chunk.get("words") or []) for chunk in repeated_chunks)

    pattern_repeated_lines = refine_repeated_patterns(best.get("timeline", []))
    repeated_lines = forced_repeated_lines + pattern_repeated_lines
    if pattern_repeated_lines:
        best["alignmentMethod"] = f"{best['alignmentMethod']}+repeated-pattern"
    if repeated_lines:
        best["matchedLines"] = sum(
            1 for row in best["timeline"]
            if float(row.get("confidence", 0.0) or 0.0) >= 0.35
        )
        best["quality"] = timeline_quality_score(lines, best["timeline"], best["matchedLines"])

    best["timeline"] = attach_token_timelines(lines, best.get("timeline", []), best.get("chunks", []))

    confidence = best["matchedLines"] / max(1, len(lines))

    respond({
        "ok": True,
        "engine": engine,
        "model": model_name,
        "device": inference_device,
        "language": language_hint or "auto",
        "selectedVariant": best["label"],
        "alignmentMethod": best["alignmentMethod"],
        "duration": best["duration"],
        "lyrics": lines,
        "timeline": best["timeline"],
        "confidence": round(confidence, 3),
        "quality": round(best["quality"], 3),
        "transcriptSegments": len(best["chunks"]),
        "transcriptWords": word_count,
        "matchedLines": best["matchedLines"],
        "rescuedLines": rescued_lines,
        "forcedLines": forced_lines,
        "repeatedLines": repeated_lines,
        "autoSegmentation": auto_segmentation,
        "compatibility": compatibility or {
            "status": "unknown",
            "score": 0.0,
            "reason": "독립 인식 결과를 평가하지 못했습니다."
        },
        "candidates": [
            {
                "variant": candidate["label"],
                "alignmentMethod": candidate["alignmentMethod"],
                "matchedLines": candidate["matchedLines"],
                "quality": round(candidate["quality"], 3),
                "transcriptHealth": round(candidate.get("transcriptHealth", 0.0), 3),
                "segments": len(candidate["chunks"])
            }
            for candidate in candidates
        ]
    })


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--audio")
    parser.add_argument("--lyrics")
    parser.add_argument("--model", default=os.environ.get("WHISPER_MODEL", "turbo"))
    args = parser.parse_args()

    try:
        if args.check:
            check_environment(args.model)
            return

        if not args.audio or not args.lyrics:
            respond({"ok": False, "error": "Audio and lyrics paths are required."})
            return

        run_alignment(args.audio, args.lyrics, args.model)
    except Exception as error:
        respond({
            "ok": False,
            "error": str(error),
            "type": error.__class__.__name__
        })


if __name__ == "__main__":
    main()

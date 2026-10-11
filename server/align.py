"""Forced alignment: known script text + audio in, timed .srt out.

Used by POST /api/align in context-server.mjs. Runs faster-whisper with
word timestamps, aligns the given script to the recognized words with
difflib, and times each script sentence from the matched word timings.
Words in the script that weren't clearly spoken are interpolated between
their spoken neighbours; ad-libbed words not in the script are dropped.

Cue contract: each script sentence is one SRT cue; newlines force a cue
break even without sentence-ending punctuation.

Usage:
    python server/align.py <audio.wav> --script-file script.txt --output out.srt
"""

import argparse
import difflib
import re
import sys

MIN_CUE_DUR = 0.20


def srt_timestamp(seconds: float) -> str:
    if seconds < 0:
        seconds = 0
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int(round((seconds - int(seconds)) * 1000))
    if millis == 1000:
        secs += 1
        millis = 0
    if secs == 60:
        minutes += 1
        secs = 0
    if minutes == 60:
        hours += 1
        minutes = 0
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def norm_word(w: str) -> str:
    return re.sub(r"[^\w']", "", w.lower(), flags=re.UNICODE)


def strip_markdown(text: str) -> str:
    """Drop markdown formatting so only spoken words reach the aligner."""
    out = []
    in_fence = False
    for raw in text.splitlines():
        line = raw
        if line.strip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if re.match(r"\s*([-*_])(\s*\1){2,}\s*$", line):
            continue  # horizontal rule
        line = re.sub(r"^#{1,6}\s+", "", line)  # headings
        line = re.sub(r"^>\s?", "", line)  # blockquote
        line = re.sub(r"^\s*([-+*]|\d+[.)])\s+", "", line)  # list markers
        line = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", line)  # images: drop
        line = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", line)  # links: keep text
        line = re.sub(r"</?[a-zA-Z][^>]*>", "", line)  # html tags
        line = line.replace("`", "").replace("~~", "")
        line = re.sub(r"(\*\*|__)(.+?)\1", r"\2", line)  # bold
        line = re.sub(r"(?<!\w)[*_]([^*_]+)[*_](?!\w)", r"\1", line)  # italic
        out.append(line)
    return "\n".join(out)


def split_cues(script: str):
    """Split script into cue texts: newlines force breaks, else sentences."""
    cues = []
    for line in script.splitlines():
        line = line.strip()
        if not line:
            continue
        # Sentence split on . ! ? … (or :) followed by space/end, keep punctuation.
        parts = re.split(r"(?<=[.!?…])\s+|(?<=[.!?…])$", line)
        for p in parts:
            p = p.strip()
            if p:
                cues.append(p)
    return cues


def main() -> int:
    parser = argparse.ArgumentParser(description="Align a known script to audio, write SRT.")
    parser.add_argument("audio", help="Input audio file (wav, preferably 16kHz mono).")
    parser.add_argument("--script-file", required=True, help="Path to the plain-text script.")
    parser.add_argument("--model", default="base")
    parser.add_argument("--output", required=True, help="Destination .srt path.")
    parser.add_argument("--language", default=None)
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--strip-markdown", action="store_true", help="Strip markdown formatting from the script first.")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("error: faster-whisper is not installed", file=sys.stderr)
        return 2

    try:
        with open(args.script_file, encoding="utf-8") as f:
            script = f.read()
        if args.strip_markdown:
            script = strip_markdown(script)
        cue_texts = split_cues(script)
        if not cue_texts:
            print("error: script has no alignable text", file=sys.stderr)
            return 3

        # script words -> (cue_idx, display_text); normalized copies for matching
        script_words, script_norm, word_cue = [], [], []
        for ci, cue in enumerate(cue_texts):
            for w in cue.split():
                script_words.append(w)
                script_norm.append(norm_word(w))
                word_cue.append(ci)

        model = WhisperModel(args.model, device="cpu", compute_type="int8")
        segments, _info = model.transcribe(
            args.audio,
            beam_size=args.beam_size,
            language=args.language,
            vad_filter=True,
            word_timestamps=True,
        )
        heard = []  # (norm, start, end)
        for seg in segments:
            for w in seg.words or []:
                nw = norm_word(w.word)
                if nw:
                    heard.append((nw, w.start, w.end))
        if not heard:
            print("error: no speech detected in audio", file=sys.stderr)
            return 4

        heard_norm = [h[0] for h in heard]
        starts = [0.0] * len(script_words)
        ends = [0.0] * len(script_words)
        anchored = [False] * len(script_words)

        sm = difflib.SequenceMatcher(a=script_norm, b=heard_norm, autojunk=False)
        for tag, i1, i2, j1, j2 in sm.get_opcodes():
            if tag == "equal":
                for k in range(i2 - i1):
                    si, (_, st, en) = i1 + k, heard[j1 + k]
                    starts[si], ends[si], anchored[si] = st, en, True
            elif tag == "replace" and j2 > j1:
                # Fuzzy region: spread script words across the heard time span.
                t0, t1 = heard[j1][1], heard[j2 - 1][2]
                n = i2 - i1
                for k in range(n):
                    si = i1 + k
                    starts[si] = t0 + (t1 - t0) * k / n
                    ends[si] = t0 + (t1 - t0) * (k + 1) / n
                    anchored[si] = True
            # insert/delete: leave unanchored, interpolate below

        # Interpolate unanchored words between nearest anchored neighbours.
        n = len(script_words)
        for i in range(n):
            if anchored[i]:
                continue
            prev_i = next((j for j in range(i - 1, -1, -1) if anchored[j]), None)
            next_i = next((j for j in range(i + 1, n) if anchored[j]), None)
            if prev_i is not None and next_i is not None:
                gap = next_i - prev_i
                t0, t1 = ends[prev_i], starts[next_i]
                if t1 < t0:
                    t1 = t0
                starts[i] = t0 + (t1 - t0) * (i - prev_i) / gap
                ends[i] = t0 + (t1 - t0) * (i + 1 - prev_i) / gap
                anchored[i] = True
            elif prev_i is not None:
                starts[i] = ends[i] = ends[prev_i]
                anchored[i] = True
            elif next_i is not None:
                starts[i] = ends[i] = starts[next_i]
                anchored[i] = True
        if not any(anchored):
            # Nothing matched at all: lay the script over the heard span evenly.
            t0, t1 = heard[0][1], heard[-1][2]
            for i in range(n):
                starts[i] = t0 + (t1 - t0) * i / n
                ends[i] = t0 + (t1 - t0) * (i + 1) / n

        # One cue per script sentence from its word span; keep cues ordered.
        cue_times = []
        for ci in range(len(cue_texts)):
            idx = [i for i in range(n) if word_cue[i] == ci]
            st = min(starts[i] for i in idx)
            en = max(ends[i] for i in idx)
            if en - st < MIN_CUE_DUR:
                en = st + MIN_CUE_DUR
            if cue_times and st < cue_times[-1][1]:
                st = cue_times[-1][1]
                if en <= st:
                    en = st + MIN_CUE_DUR
            cue_times.append((st, en))

        with open(args.output, "w", encoding="utf-8") as f:
            for i, (text, (st, en)) in enumerate(zip(cue_texts, cue_times), start=1):
                f.write(f"{i}\n{srt_timestamp(st)} --> {srt_timestamp(en)}\n{text}\n\n")
    except Exception as exc:
        print(f"error: alignment failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

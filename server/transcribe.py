"""Local speech-to-text: audio file in, .srt file out.

Used by GET /api/transcript in context-server.mjs. Runs faster-whisper
(CPU, int8) over a 16kHz mono wav prepared by ffmpeg and writes
segment-level SubRip subtitles.

Usage:
    python server/transcribe.py <audio.wav> --model base --output out.srt
"""

import argparse
import sys


def srt_timestamp(seconds: float) -> str:
    if seconds < 0:
        seconds = 0
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int(round((seconds - int(seconds)) * 1000))
    # carry overflow from rounding (e.g. 0.9999 -> 1000ms)
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


def main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe audio to SRT with faster-whisper.")
    parser.add_argument("audio", help="Input audio file (wav, preferably 16kHz mono).")
    parser.add_argument("--model", default="base", help="Whisper model size (default: base).")
    parser.add_argument("--output", required=True, help="Destination .srt path.")
    parser.add_argument("--language", default=None, help="Optional ISO language code (default: auto-detect).")
    parser.add_argument("--beam-size", type=int, default=5)
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("error: faster-whisper is not installed", file=sys.stderr)
        return 2

    try:
        model = WhisperModel(args.model, device="cpu", compute_type="int8")
        segments, _info = model.transcribe(
            args.audio,
            beam_size=args.beam_size,
            language=args.language,
            vad_filter=True,
        )
        with open(args.output, "w", encoding="utf-8") as f:
            for i, seg in enumerate(segments, start=1):
                text = seg.text.strip()
                if not text:
                    continue
                f.write(f"{i}\n{srt_timestamp(seg.start)} --> {srt_timestamp(seg.end)}\n{text}\n\n")
    except Exception as exc:  # surface to node via stderr + non-zero exit
        print(f"error: transcription failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

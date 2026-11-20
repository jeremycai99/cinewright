"""The audio image's entry point, `audio-job`.

Subcommands:
- `versions`: print what the image holds (see versions.py) as JSON.
- `imports`: import kokoro, misaki's English G2P and whisperx, and fail if any of them
  tries to reach the network. Used to check the image runs offline.
"""

from __future__ import annotations

import argparse
import json
import socket
import sys
from typing import Any


def _imports() -> int:
    attempts: list[str] = []
    real_connect = socket.socket.connect

    def guarded(self: socket.socket, address: Any) -> None:
        attempts.append(repr(address))
        raise OSError(f"network disabled in the audio image: {address!r}")

    socket.socket.connect = guarded  # type: ignore[method-assign]
    try:
        import kokoro  # noqa: F401
        import whisperx  # noqa: F401
        from misaki import en, espeak

        en.G2P(trf=False, british=False, fallback=espeak.EspeakFallback(british=False))
    finally:
        socket.socket.connect = real_connect  # type: ignore[method-assign]
    if attempts:
        print(f"network attempts during import: {', '.join(attempts)}", file=sys.stderr)
        return 1
    print("ok: kokoro, misaki[en] and whisperx import offline")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="audio-job")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("versions", help="print the image's versions as JSON")
    sub.add_parser("imports", help="import the TTS and STT stacks with the network blocked")
    args = parser.parse_args(argv)
    if args.command == "versions":
        from audio_job.versions import report

        print(json.dumps(report(), indent=2, sort_keys=True))
        return 0
    return _imports()


if __name__ == "__main__":
    sys.exit(main())

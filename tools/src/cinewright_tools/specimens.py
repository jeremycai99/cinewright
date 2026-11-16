"""Check every component specimen in the pinned render image (M2.4b).

``pnpm --filter @cinewright/components specimens -- --out <root>`` writes one composition per
pack and delivery profile under ``<root>/<pack>/<profile>/`` with ``samples.json``. This tool runs
``render-job check`` on each at its sample times, renders it to MP4, and makes a contact sheet of
the sample frames for the reviewer. Any failing check fails the run.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import sys
from pathlib import Path

from cinewright_tools.container import bind_mount, docker_run_base, run_check, run_render

__all__ = ["generate_assets", "main", "render_stills", "run_check", "select_filter"]


def select_filter(samples: list[float], fps: dict[str, int]) -> str:
    """An FFmpeg filter that tiles the frames at ``samples`` (seconds) into one sheet."""
    frames = sorted({round(t * fps["num"] / fps["den"]) for t in samples})
    terms = "+".join(f"eq(n\\,{n})" for n in frames)
    columns = min(len(frames), 4)
    rows = math.ceil(len(frames) / columns)
    return f"select='{terms}',scale=480:-1,tile={columns}x{rows}"


def generate_assets(image: str, directory: Path) -> None:
    """Make the clips a specimen lists in ``generated.json`` with the image's FFmpeg."""
    listing = directory / "generated.json"
    if not listing.is_file():
        return
    docker = shutil.which("docker") or "docker"
    for asset in json.loads(listing.read_text()):
        target = directory / asset["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        command = docker_run_base(docker)
        command += [
            "--mount",
            bind_mount(directory, "/w", readonly=False),
            "--entrypoint",
            "ffmpeg",
        ]
        command += [image, "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi"]
        command += ["-i", asset["lavfi"], "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an"]
        command += ["-threads", "1", "-map_metadata", "-1", "-fflags", "+bitexact"]
        command += ["-flags:v", "+bitexact", f"/w/{asset['path']}"]
        subprocess.run(command, capture_output=True, text=True, check=True)


def render_stills(image: str, directory: Path, samples: list[float], fps: dict[str, int]) -> None:
    """Render ``directory`` to MP4 and tile its sample frames into ``contact-sheet.png``."""
    render = run_render(image, directory, directory.parent / f"{directory.name}.render", "mp4")
    if render.exit_code != 0:
        raise RuntimeError(f"render failed for {directory}: {render.stderr}")
    docker = shutil.which("docker") or "docker"
    command = docker_run_base(docker)
    command += [
        "--mount",
        bind_mount(render.out_dir, "/w", readonly=False),
        "--entrypoint",
        "ffmpeg",
    ]
    command += [image, "-nostdin", "-loglevel", "error", "-y", "-i", "/w/output.mp4"]
    command += ["-vf", select_filter(samples, fps), "-frames:v", "1", "-fps_mode", "vfr"]
    command += ["/w/contact-sheet.png"]
    subprocess.run(command, capture_output=True, text=True, check=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="cinewright-check-specimens",
        description="Check every component specimen under ROOT in the pinned render image.",
    )
    parser.add_argument("--image", required=True)
    parser.add_argument("--no-stills", action="store_true", help="skip the MP4 and contact sheet")
    parser.add_argument("root", type=Path)
    args = parser.parse_args(argv)
    if shutil.which("docker") is None:
        print("Docker is not available: install a Docker runtime and start it", file=sys.stderr)
        return 2
    root: Path = args.root
    failed: list[str] = []
    results: dict[str, list[dict[str, object]]] = {}
    for samples_file in sorted(root.glob("*/*/samples.json")):
        directory = samples_file.parent
        name = directory.relative_to(root).as_posix()
        meta = json.loads(samples_file.read_text())
        generate_assets(args.image, directory)
        result = run_check(
            args.image, directory, directory.parent / f"{directory.name}.check", meta["samples"]
        )
        results[name] = result.failures
        if result.exit_code != 0 or result.failures:
            failed.append(name)
            reported = result.failures or [
                {"section": "check", "severity": "error", "code": f"exit {result.exit_code}"}
            ]
            for f in reported:
                where = f"at {f.get('time', '-')}s {f.get('selector', '')}"
                line = f"{name}: {f.get('section')} {f.get('severity')} {f.get('code')} {where}"
                print(f"{line} {f.get('message', '')}".rstrip())
        else:
            print(f"{name}: ok")
        if not args.no_stills:
            render_stills(args.image, directory, meta["samples"], meta["fps"])
    (root / "summary.json").write_text(
        json.dumps({"failed": failed, "results": results}, indent=2) + "\n", encoding="utf-8"
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

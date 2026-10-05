"""Assembles .local/capture/frames.json into docs/preview.gif (captioned, quantized, < 3 MB)."""

import json
from pathlib import Path
from typing import TypedDict

from PIL import Image, ImageDraw, ImageFont

CAPTURE = Path(".local/capture")
OUT = Path("docs/preview.gif")
WIDTH = 960
CAPTION_H = 34


class Frame(TypedDict):
    file: str
    ms: int
    caption: str


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for name in ("DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def frame(path: str, caption: str) -> Image.Image:
    shot = Image.open(path).convert("RGB")
    shot = shot.resize(
        (WIDTH, round(shot.height * WIDTH / shot.width)), Image.Resampling.LANCZOS
    )
    canvas = Image.new("RGB", (WIDTH, shot.height + CAPTION_H), (24, 24, 23))
    canvas.paste(shot, (0, CAPTION_H))
    ImageDraw.Draw(canvas).text((14, 9), caption, fill=(236, 235, 228), font=font(15))
    return canvas


def main() -> None:
    frames: list[Frame] = json.loads((CAPTURE / "frames.json").read_text())
    images = [frame(f["file"], f["caption"]) for f in frames]
    # A palette per frame keeps small accents (status colours, terminal green) that a shared one drops.
    quantized = [
        im.quantize(
            colors=192, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE
        )
        for im in images
    ]
    OUT.parent.mkdir(exist_ok=True)
    quantized[0].save(
        OUT,
        save_all=True,
        append_images=quantized[1:],
        duration=[f["ms"] for f in frames],
        loop=0,
        optimize=True,
    )
    print(f"{OUT}: {len(frames)} frames, {OUT.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()

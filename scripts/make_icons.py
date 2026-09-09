#!/usr/bin/env python3
"""以 PIL 產生擴充元件圖示：#5865f2 圓角方塊配白色「譯」字，輸出 16/48/128 PNG。"""

import os

from PIL import Image, ImageDraw, ImageFont

BRAND = (88, 101, 242, 255)
WHITE = (255, 255, 255, 255)
FONT_PATH = "/System/Library/Fonts/Hiragino Sans GB.ttc"
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "extension", "icons")
SIZES = (16, 48, 128)
SUPERSAMPLE = 8


def load_font(px):
    for index in (0, 1, 2):
        try:
            return ImageFont.truetype(FONT_PATH, px, index=index)
        except Exception:
            continue
    return None


def draw_glyph(draw, font, box):
    """有字型畫「譯」，否則畫白色 T 形。"""
    if font is not None:
        left, top, right, bottom = draw.textbbox((0, 0), "譯", font=font)
        x = (box - (right - left)) / 2 - left
        y = (box - (bottom - top)) / 2 - top
        draw.text((x, y), "譯", font=font, fill=WHITE)
        return
    bar = box * 0.14
    draw.rectangle([box * 0.22, box * 0.28, box * 0.78, box * 0.28 + bar], fill=WHITE)
    draw.rectangle([box * 0.5 - bar / 2, box * 0.28, box * 0.5 + bar / 2, box * 0.74], fill=WHITE)


def make(size):
    box = size * SUPERSAMPLE
    img = Image.new("RGBA", (box, box), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle([0, 0, box - 1, box - 1], radius=int(box * 0.22), fill=BRAND)
    draw_glyph(draw, load_font(int(box * 0.66)), box)
    return img.resize((size, size), Image.LANCZOS)


def main():
    out = os.path.normpath(OUT_DIR)
    os.makedirs(out, exist_ok=True)
    for size in SIZES:
        path = os.path.join(out, "icon%d.png" % size)
        make(size).save(path, "PNG")
        print("wrote", path)


if __name__ == "__main__":
    main()

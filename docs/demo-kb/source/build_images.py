"""Image post-processing for the demo set.

Usage: py docs/demo-kb/source/build_images.py <tmp-dir> <files-dir>
- decline.png (Chrome screenshot) -> payment-decline-codes.jpg
- memo.png (Chrome screenshot) -> a scanned-looking, image-only PDF with no
  text layer, so ingestion has to OCR it: pin-change-memo-scan.pdf
"""
import random
import sys
from pathlib import Path

from PIL import Image, ImageFilter

tmp, files = Path(sys.argv[1]), Path(sys.argv[2])

Image.open(tmp / "decline.png").convert("RGB").save(
    files / "payment-decline-codes.jpg", "JPEG", quality=88
)

memo = Image.open(tmp / "memo.png").convert("L")
rng = random.Random(14)  # fixed seed: rebuilds are identical
noise = Image.effect_noise(memo.size, 18).point(lambda v: 128 + (v - 128) // 3)
memo = Image.blend(memo, noise, 0.08)
memo = memo.rotate(0.7 + rng.random() * 0.1, resample=Image.BICUBIC, expand=True, fillcolor=245)
memo = memo.filter(ImageFilter.GaussianBlur(0.6))
memo.convert("RGB").save(files / "pin-change-memo-scan.pdf", "PDF", resolution=150)
print("images done")

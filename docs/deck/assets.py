"""Generate raster assets for the Kritva deck: gradients, patterns, icons, Harvey balls, wordmark.

Everything decorative is baked into PNG so Google Slides imports it pixel-for-pixel.
"""
import io
import os
import re

import cairosvg
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "assets")
ICONS = os.path.join(HERE, "dl", "icons", "package", "icons")
os.makedirs(OUT, exist_ok=True)

BLACK = (10, 10, 10)
ORANGE = (204, 85, 0)
ORANGE_HOT = (255, 122, 26)
EMBER = (110, 34, 0)
O50 = (255, 244, 236)
O100 = (255, 232, 214)
WHITE = (255, 255, 255)

DPI = 200  # px per inch for full-bleed art
RNG = np.random.default_rng(7)


def grain(arr, amount=7.0):
    noise = RNG.normal(0, amount, arr.shape[:2])[..., None]
    return np.clip(arr + noise, 0, 255)


def radial(w, h, cx, cy, rx, ry):
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2)
    return np.clip(1 - d, 0, 1)


def blend(base, color, mask, power=1.6):
    m = (mask ** power)[..., None]
    return base * (1 - m) + np.array(color, np.float32) * m


def save(arr_or_img, name):
    img = arr_or_img if isinstance(arr_or_img, Image.Image) else Image.fromarray(arr_or_img.astype(np.uint8))
    img.save(os.path.join(OUT, name), optimize=True)


# ---------------------------------------------------------------- full-bleed dark art
def ember_canvas(w_in, h_in, cx, cy, scale=1.0, flip=False):
    w, h = int(w_in * DPI), int(h_in * DPI)
    base = np.zeros((h, w, 3), np.float32) + np.array(BLACK, np.float32)
    cx, cy = cx * w, cy * h
    base = blend(base, EMBER, radial(w, h, cx, cy, w * 0.75 * scale, h * 1.15 * scale), 1.3)
    base = blend(base, ORANGE, radial(w, h, cx, cy, w * 0.48 * scale, h * 0.78 * scale), 1.5)
    base = blend(base, ORANGE_HOT, radial(w, h, cx, cy, w * 0.22 * scale, h * 0.36 * scale), 1.8)
    # a second, cooler counter-glow so the field is not a flat spotlight
    ox = w * (0.05 if not flip else 0.95)
    base = blend(base, (60, 22, 6), radial(w, h, ox, h * 0.05, w * 0.5, h * 0.7), 2.2)
    img = Image.fromarray(grain(base, 6).astype(np.uint8))
    # concentric contour arcs centred on the glow (pattern layer)
    over = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    for i, r in enumerate(np.linspace(h * 0.22, h * 1.9, 15)):
        a = int(70 - i * 3.6)
        if a <= 0:
            break
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(255, 190, 140, a), width=2)
    img = Image.alpha_composite(img.convert("RGBA"), over).convert("RGB")
    return img


save(ember_canvas(13.333, 7.5, 0.82, 0.86), "cover.png")
save(ember_canvas(13.333, 7.5, 0.12, 0.92, 1.05, flip=True), "divider.png")


# ---------------------------------------------------------------- so-what bar (rounded, black with ember edge)
def rounded_mask(w, h, r):
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, w - 1, h - 1], r, fill=255)
    return m


def sowhat_bar(w_in, h_in, name):
    s = 300
    w, h = int(w_in * s), int(h_in * s)
    base = np.zeros((h, w, 3), np.float32) + np.array(BLACK, np.float32)
    base = blend(base, EMBER, radial(w, h, w * 1.0, h * 0.5, w * 0.42, h * 4.0), 1.2)
    base = blend(base, ORANGE, radial(w, h, w * 1.02, h * 0.5, w * 0.22, h * 2.6), 1.4)
    img = Image.fromarray(grain(base, 4).astype(np.uint8)).convert("RGBA")
    img.putalpha(rounded_mask(w, h, int(0.08 * s)))
    save(img, name)


sowhat_bar(12.333, 0.40, "sowhat.png")


# ---------------------------------------------------------------- warm callout card with dot-grid pattern
def warm_card(w_in, h_in, name, glow=(0.95, 0.1)):
    s = 300
    w, h = int(w_in * s), int(h_in * s)
    base = np.zeros((h, w, 3), np.float32) + np.array(O50, np.float32)
    base = blend(base, O100, radial(w, h, w * glow[0], h * glow[1], w * 0.7, h * 1.6), 1.1)
    base = blend(base, (246, 207, 177), radial(w, h, w * glow[0], h * glow[1], w * 0.3, h * 0.8), 1.6)
    img = Image.fromarray(grain(base, 2.5).astype(np.uint8)).convert("RGBA")
    over = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    step = int(0.12 * s)
    for yy in range(step // 2, h, step):
        for xx in range(step // 2, w, step):
            fade = max(0.0, 1 - ((xx / w - glow[0]) ** 2 + (yy / h - glow[1]) ** 2) ** 0.5 * 1.25)
            a = int(70 * fade)
            if a > 2:
                d.ellipse([xx - 3, yy - 3, xx + 3, yy + 3], fill=(204, 85, 0, a))
    img = Image.alpha_composite(img, over)
    img.putalpha(rounded_mask(w, h, int(0.12 * s)))
    save(img, name)


warm_card(5.95, 1.32, "eqcard.png")
warm_card(1.85, 1.08, "callout_s2.png", glow=(0.9, 0.0))
warm_card(6.1, 1.0, "callout_s4.png", glow=(1.0, 0.5))


# ---------------------------------------------------------------- icons (Lucide, ISC licence)
def icon(name, color, out_name, px=192, stroke=1.75):
    svg = open(os.path.join(ICONS, name + ".svg")).read()
    hexc = "#%02x%02x%02x" % color
    svg = svg.replace('stroke="currentColor"', f'stroke="{hexc}"')
    svg = re.sub(r'stroke-width="[\d.]+"', f'stroke-width="{stroke}"', svg)
    png = cairosvg.svg2png(bytestring=svg.encode(), output_width=px, output_height=px)
    Image.open(io.BytesIO(png)).save(os.path.join(OUT, out_name))


ICON_SET = {
    "clock": "clock", "brain": "brain", "layers": "layers", "user-check": "user-check", "radar": "radar",
    "building": "building-2", "briefcase": "briefcase-business", "truck": "truck", "app": "app-window",
    "party": "party-popper", "key": "key-round", "timer": "timer", "scale": "scale", "shield": "shield-check",
    "phone": "phone-incoming", "x": "circle-x", "users": "users", "check": "circle-check",
}
for short, lucide in ICON_SET.items():
    icon(lucide, ORANGE, f"i_{short}_o.png")
    icon(lucide, BLACK, f"i_{short}_k.png")
    icon(lucide, WHITE, f"i_{short}_w.png")


# ---------------------------------------------------------------- Harvey balls
def harvey(fraction, color, name, px=160):
    s = 4
    big = px * s
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = 6 * s
    box = [pad, pad, big - pad, big - pad]
    d.ellipse(box, fill=(255, 255, 255, 255), outline=color + (255,), width=10 * s)
    if fraction >= 1:
        d.ellipse(box, fill=color + (255,))
    elif fraction > 0:
        d.pieslice(box, -90, -90 + 360 * fraction, fill=color + (255,))
    img = img.resize((px, px), Image.LANCZOS)
    img.save(os.path.join(OUT, name))


for frac, tag in [(1, "full"), (0.5, "half"), (0.25, "quarter"), (0, "empty")]:
    harvey(frac, BLACK, f"hb_{tag}_k.png")
    harvey(frac, ORANGE, f"hb_{tag}_o.png")


# ---------------------------------------------------------------- wordmark in Geist Serif
def wordmark(color, name, size=420):
    font = ImageFont.truetype(os.path.join(HERE, "dl", "fonts", "GeistSerif.ttf"), size)
    try:
        font.set_variation_by_axes([0])
    except Exception:
        pass
    bbox = font.getbbox("Kritva")
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    img = Image.new("RGBA", (w + 8, h + 8), (0, 0, 0, 0))
    ImageDraw.Draw(img).text((4 - bbox[0], 4 - bbox[1]), "Kritva", font=font, fill=color + (255,))
    img.save(os.path.join(OUT, name))
    return (w + 8) / (h + 8)


ratio = wordmark(BLACK, "wordmark_k.png")
wordmark(WHITE, "wordmark_w.png")
with open(os.path.join(OUT, "wordmark_ratio.txt"), "w") as f:
    f.write(str(ratio))
print("assets ok, wordmark ratio", round(ratio, 3))

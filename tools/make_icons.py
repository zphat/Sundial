"""Renders the Sundial mark (lime dial, three dark rings) to every icon the app ships.

Run from the repo root:  python tools/make_icons.py
Needs Pillow. Writes src-tauri/icons/*.png + icon.ico and ui/icons/*.png. The geometry mirrors
ui/index.html's inline SVG (viewBox 0 0 28 28); the rings here are frozen at the "hero" angles, the
header's rings turn with the time of day.
"""
import math, os, sys
from PIL import Image, ImageDraw

LIME = (0xD1, 0xFF, 0x4A, 255)
INK = (0x0B, 0x0D, 0x06, 255)
BOX = 28.0  # SVG units

# ring radius, stroke width, start angle, sweep (degrees, clockwise from 12 o'clock). The end of the
# sweep is the ring's "hand". Same numbers as the SVG paths in index.html.
RINGS = [
    (9.3, 2.0, 235, 195),    # hours: the outer volute; the end of its sweep is the hour hand
    (6.3, 2.0, 335, 155),    # middle ring: turns slowly the other way
    (3.3, 2.0, 80, 235),     # inner ring: turns once a minute
]
# Below 40px the middle ring is dropped and the strokes thicken, or the rings melt together.
RINGS_SMALL = [
    (9.0, 2.4, 235, 195),
    (3.9, 2.4, 80, 235),
]
DOT_R = 1.5
DISC_R = 12.5
RIM = 1.5


def pt(cx, r, deg):
    a = math.radians(deg - 90)
    return (cx + r * math.cos(a), cx + r * math.sin(a))


def render(size, pad=0.0, plate=None, dot=True):
    """size in px. pad = fraction of the box kept clear around the disc (maskable icons). plate = opaque
    background colour or None for transparency."""
    ss = 4  # supersample
    S = size * ss
    im = Image.new("RGBA", (S, S), plate + (255,) if plate else (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    scale = S / BOX * (1 - 2 * pad)
    off = S * pad
    c = off + 14 * scale

    def px(v):
        return v * scale

    # disc with rim
    r = px(DISC_R)
    d.ellipse([c - r, c - r, c + r, c + r], fill=INK)
    r2 = px(DISC_R - RIM)
    d.ellipse([c - r2, c - r2, c + r2, c + r2], fill=LIME)
    # rings: PIL draws an arc's width inward from the bounding box, so the box radius is R + W/2 and the
    # stroke is centred on R; the round caps then sit exactly on the stroke.
    for rad, w, start, sweep in (RINGS if size >= 40 else RINGS_SMALL):
        R = px(rad)
        W = px(w)
        Rb = R + W / 2
        a0 = start - 90
        a1 = start + sweep - 90
        d.arc([c - Rb, c - Rb, c + Rb, c + Rb], a0, a1, fill=INK, width=int(round(W)))
        for deg in (start, start + sweep):
            x, y = pt(c, R, deg)
            d.ellipse([x - W / 2, y - W / 2, x + W / 2, y + W / 2], fill=INK)
    if dot:
        rd = px(DOT_R)
        d.ellipse([c - rd, c - rd, c + rd, c + rd], fill=INK)
    return im.resize((size, size), Image.LANCZOS)


def svg_paths():
    """Path data for the header SVG: each ring is drawn with its hand at 12 o'clock, so a rotate() of the
    current angle points the hand at the time."""
    out = []
    for rad, w, start, sweep in RINGS:
        s0 = -sweep  # start so that the end lands at 0 degrees (12 o'clock)
        x0, y0 = pt(14, rad, s0)
        x1, y1 = pt(14, rad, 0)
        large = 1 if sweep > 180 else 0
        out.append(f'M{x0:.2f} {y0:.2f}A{rad} {rad} 0 {large} 1 {x1:.2f} {y1:.2f}')
    return out


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--svg':
        for d in svg_paths():
            print(d)
        return
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = sys.argv[1] if len(sys.argv) > 1 else root
    tauri = os.path.join(out, "src-tauri", "icons")
    web = os.path.join(out, "ui", "icons")
    os.makedirs(tauri, exist_ok=True)
    os.makedirs(web, exist_ok=True)
    big = render(1024)
    big.save(os.path.join(tauri, "icon.png"))
    big.resize((512, 512), Image.LANCZOS).save(os.path.join(tauri, "icon-512.png"))
    for n, name in [(32, "32x32.png"), (128, "128x128.png"), (256, "128x128@2x.png")]:
        render(n).save(os.path.join(tauri, name))
    render(256).save(os.path.join(tauri, "icon.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    for n in (32, 128, 192, 256, 512):
        render(n).save(os.path.join(web, f"icon-{n}.png"))
    render(512, pad=0.1).save(os.path.join(web, "icon-512-maskable.png"))
    render(180, pad=0.08, plate=(0x0B, 0x0C, 0x0B)).save(os.path.join(web, "apple-touch-icon.png"))
    print("icons written to", tauri, "and", web)


if __name__ == "__main__":
    main()

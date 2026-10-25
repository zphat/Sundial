"""Renders the Sundial mark to every icon the app ships, and prints the SVG paths the header uses.

Run from the repo root:  python tools/make_icons.py          writes src-tauri/icons/* and ui/icons/*
                         python tools/make_icons.py --svg    prints the three ring paths (head at 12 o'clock)
Needs Pillow. The mark: a lime dial with three dark comet-like rings, each thick at its head and tapering to a
point along its tail. In the app the rings turn (the outer one is the hour hand); the icons freeze them at HEADS.
"""
import math, os, sys
from PIL import Image, ImageDraw

LIME = (0xD1, 0xFF, 0x4A, 255)
INK = (0x0B, 0x0D, 0x06, 255)
BOX = 28.0  # SVG units, centre at 14,14

# (centre radius, head width, sweep in degrees, taper power). Head width is the stroke at the thick end; the
# tail thins to a point. Taper power 1 = linear, higher = thins sooner.
RINGS = [
    (9.4, 1.6, 205, 1.35),   # hours: the outer ring, its head is the hour hand
    (6.4, 1.5, 160, 1.35),   # middle ring (turns the other way in the app)
    (3.5, 1.4, 225, 1.35),   # inner ring
]
# head angles for the still icons, degrees clockwise from 12 o'clock; 120 apart so the three tails swirl evenly
HEADS = [70, 190, 310]
# in the app the middle ring turns counter-clockwise, so its head leads the other way
DIRS = [1, -1, 1]
DOT_R = 1.45
DISC_R = 12.5
RIM = 1.5
TAIL_MIN = 0.14


def pt(cx, r, deg):
    a = math.radians(deg - 90)
    return (cx + r * math.cos(a), cx + r * math.sin(a))


def outline(cx, scale, r, w, sweep, head, d, power, n=36):
    """Closed polygon (list of points) for one tapered ring, head at angle `head`, tail trailing against `d`."""
    outer, inner = [], []
    for i in range(n + 1):
        t = i / n
        ang = head - d * t * sweep
        wt = max(TAIL_MIN, w * (1 - t) ** power)
        outer.append(pt(cx, (r + wt / 2) * scale, ang))
        inner.append(pt(cx, (r - wt / 2) * scale, ang))
    # round head cap: a half circle over the front of the head, from the inner edge round to the outer edge.
    # u points outward from the centre at the head, f points the way the head travels.
    hx, hy = pt(cx, r * scale, head)
    base = math.radians(head - 90)
    ux, uy = math.cos(base), math.sin(base)
    fx, fy = -d * uy, d * ux
    cap = []
    for k in range(1, 12):
        phi = math.pi - math.pi * k / 12          # 180 deg (inner edge) down to 0 deg (outer edge) via the front
        cap.append((hx + w / 2 * scale * (math.cos(phi) * ux + math.sin(phi) * fx),
                    hy + w / 2 * scale * (math.cos(phi) * uy + math.sin(phi) * fy)))
    return list(reversed(inner)) + cap + outer


def render(size, pad=0.0, plate=None, dot=True, rings=None, heads=None):
    """size in px. pad = fraction kept clear around the disc (maskable icons). plate = opaque background."""
    rings = rings or RINGS
    heads = heads or HEADS
    ss = 4
    S = size * ss
    im = Image.new("RGBA", (S, S), plate + (255,) if plate else (0, 0, 0, 0))
    dr = ImageDraw.Draw(im)
    scale = S / BOX * (1 - 2 * pad)
    c = S * pad + 14 * scale
    R = DISC_R * scale
    dr.ellipse([c - R, c - R, c + R, c + R], fill=INK)
    R2 = (DISC_R - RIM) * scale
    dr.ellipse([c - R2, c - R2, c + R2, c + R2], fill=LIME)
    small = size < 40
    for i, (r, w, sweep, power) in enumerate(rings):
        if small and i == 1:
            continue  # two rings read better under 40px
        w2 = w * (1.3 if small else 1.0)
        dr.polygon(outline(c, scale, r, w2, sweep, heads[i], DIRS[i], power, n=48), fill=INK)
    if dot:
        rd = DOT_R * scale
        dr.ellipse([c - rd, c - rd, c + rd, c + rd], fill=INK)
    return im.resize((size, size), Image.LANCZOS)


def svg_paths():
    """Path data for the header: each ring with its head at 12 o'clock, so rotate(angle) points the head."""
    out = []
    for (r, w, sweep, power), d in zip(RINGS, DIRS):
        pts = outline(14, 1.0, r, w, sweep, 0, d, power, n=28)
        out.append("M" + "L".join(f"{x:.2f} {y:.2f}" for x, y in pts) + "Z")
    return out


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--svg":
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

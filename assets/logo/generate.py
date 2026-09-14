"""Generate every Nessie app icon, favicon and splash mark from one geometry.

The N mark is defined analytically (lines and circles fitted to the original
artwork), so every raster is drawn from the shape itself rather than resampled
from a PNG with a soft, fringed edge. The same numbers write the SVG masters.

Run from the repository root:

    python3 -m venv /tmp/nessie-icons && /tmp/nessie-icons/bin/pip install pillow numpy
    /tmp/nessie-icons/bin/python assets/logo/generate.py

iconutil (macOS) is required for the .icns files.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]

# Brand colours. DARK is the icon ground; LIGHT is the alternative ground.
DARK = '#07152C'
LIGHT = '#FFFFFF'
COLOURS = {
    'light_green': '#3AEFB1',
    'green': '#04BC8F',
    'blue': '#01A8FC',
    'deep_blue': '#0066FC',
    'yellow': '#FDC501',
    'pink': '#FC2D8A',
}

# ---------------------------------------------------------------------------
# Geometry, in the 1254-unit space of the source artwork. Lines are y = m*x + c.
U = (1.13618, -349.66)  # diagonal band, top edge
D = (1.09926, 130.914)  # diagonal band, bottom edge
D2 = (1.13836, 102.969)  # pink, bottom-left edge
L = (0.99142, 185.828)  # light green / green cut
Y = (1.09662, -321.059)  # deep blue / yellow cut
P = (-0.96646, 1607.01)  # yellow + deep blue / pink cut
XL0, XL1, XR0, XR1 = 152.6, 478.5, 734.5, 1101.3
C1 = (334.55, 305.85, 181.95)  # left stem top: tangent to its left side and U
C2 = (315.55, 955.85, 162.95)  # left stem bottom
C3 = (918.05, 307.05, 183.25)  # right stem top
C4 = (956.64, 972.84, 144.66)  # right stem bottom: tangent to its right side and D2
TX, TY = 848.0, 1068.3  # where D2 meets C4
BBOX = (XL0, 123.9, XR1, 1118.8)


def line_y(line: tuple[float, float], x: float) -> float:
    return line[0] * x + line[1]


def _hex(value: str) -> tuple[int, int, int]:
    return tuple(int(value[i:i + 2], 16) for i in (1, 3, 5))


def _inside(x, y, circle):
    return (x - circle[0]) ** 2 + (y - circle[1]) ** 2 <= circle[2] ** 2


def _below(x, y, line):
    return y >= line[0] * x + line[1]


ORDER = ['light_green', 'green', 'blue', 'deep_blue', 'yellow', 'pink']


def _regions(x, y):
    left = (x >= XL0) & (x <= XL1) & (
        ((y >= C1[1]) & (y <= C2[1])) | _inside(x, y, C1) | _inside(x, y, C2)
    )
    band = (x >= XL1 - 0.5) & (x <= XR0 + 0.5) & _below(x, y, U) & ~_below(x, y, D)
    right = (x >= XR0) & (x <= XR1) & ~_below(x, y, D2) & (
        ((y >= C3[1]) & (y <= C4[1]))
        | _inside(x, y, C3)
        | ((y > C4[1]) & (x <= TX))
        | _inside(x, y, C4)
    )
    label = np.full(x.shape, 1, np.int8)
    label[(x < XL1) & ~_below(x, y, L)] = 0
    label[(x >= XL1) & (x < XR0)] = 2
    right_side = x >= XR0
    label[right_side] = 4
    label[right_side & _below(x, y, Y) & ~_below(x, y, P)] = 3
    label[right_side & _below(x, y, P)] = 5
    return left | band | right, label


def render(
    size: int,
    glyph_height: float,
    ground: str | None = None,
    shape: str = 'square',
    plate_inset: float = 0.0,
    radius: float = 0.2237,
    supersample: int = 4,
) -> Image.Image:
    """Draw the mark centred on a `size` px canvas.

    glyph_height -- mark height as a fraction of the canvas.
    ground       -- background colour, or None for transparent.
    shape        -- 'square' (full bleed), 'rounded' or 'circle'.
    plate_inset  -- transparent margin around a rounded/circle ground, as a fraction.
    radius       -- rounded-rect corner radius as a fraction of the plate.
    """
    n = size * supersample
    grid = (np.arange(n) + 0.5) / supersample
    X, Yg = np.meshgrid(grid, grid)
    width, height = BBOX[2] - BBOX[0], BBOX[3] - BBOX[1]
    scale = size * glyph_height / height
    ox = (size - width * scale) / 2 - BBOX[0] * scale
    oy = (size - height * scale) / 2 - BBOX[1] * scale
    silhouette, label = _regions((X - ox) / scale, (Yg - oy) / scale)

    image = np.zeros((n, n, 4), float)
    if ground is not None:
        x0 = size * plate_inset
        extent = size - 2 * x0
        if shape == 'square':
            cover = np.ones((n, n), bool)
        elif shape == 'circle':
            centre = size / 2
            cover = (X - centre) ** 2 + (Yg - centre) ** 2 <= (extent / 2) ** 2
        else:
            r = extent * radius
            qx = np.clip(X, x0 + r, x0 + extent - r)
            qy = np.clip(Yg, x0 + r, x0 + extent - r)
            cover = ((X - qx) ** 2 + (Yg - qy) ** 2 <= r * r) & (X >= x0) & (X <= x0 + extent) \
                & (Yg >= x0) & (Yg <= x0 + extent)
        image[cover] = (*_hex(ground), 255)
    for index, key in enumerate(ORDER):
        image[silhouette & (label == index)] = (*_hex(COLOURS[key]), 255)

    alpha = image[..., 3:4] / 255.0
    premultiplied = np.concatenate([image[..., :3] * alpha, alpha], -1)
    premultiplied = premultiplied.reshape(size, supersample, size, supersample, 4).mean((1, 3))
    coverage = premultiplied[..., 3:4]
    out = np.zeros_like(premultiplied)
    out[..., :3] = np.where(coverage > 0, premultiplied[..., :3] / np.maximum(coverage, 1e-9), 0)
    out[..., 3] = coverage[..., 0] * 255
    return Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8), 'RGBA')


# ---------------------------------------------------------------------------
# Icon families. Glyph heights follow the supplied dark example (the mark is
# ~70% of its plate).

def mark(size):  # transparent, for favicons and splash screens
    return render(size, 0.94)


def full_bleed(size, ground):  # the OS masks the corners (iOS, maskable, tiles)
    return render(size, 0.62, ground)


def rounded(size):  # a finished rounded plate edge to edge (web logo, .ico)
    return render(size, 0.66, DARK, 'rounded')


def mac(size):  # macOS icon grid: 824/1024 plate, transparent margin
    return render(size, 0.56, DARK, 'rounded', plate_inset=100 / 1024, radius=185 / 824)


def android_legacy(size, shape):
    return render(size, 0.54, DARK, shape, plate_inset=0.04, radius=0.18)


def android_foreground(size):  # 108dp layer; the launcher shows the inner 72dp
    return render(size, 0.44)


# ---------------------------------------------------------------------------

def save(image: Image.Image, relative: str, rgb: bool = False) -> None:
    path = ROOT / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    (image.convert('RGB') if rgb else image).save(path, optimize=True)
    print('wrote', relative)


def save_ico(render_size, relative: str, sizes) -> None:
    images = [render_size(s) for s in sizes]
    path = ROOT / relative
    images[-1].save(path, format='ICO', sizes=[(s, s) for s in sizes], append_images=images[:-1])
    print('wrote', relative)


def save_icns(relative: str) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / 'icon.iconset'
        iconset.mkdir()
        for base in (16, 32, 128, 256, 512):
            mac(base).save(iconset / f'icon_{base}x{base}.png')
            mac(base * 2).save(iconset / f'icon_{base}x{base}@2x.png')
        subprocess.run(['iconutil', '-c', 'icns', str(iconset), '-o', str(ROOT / relative)], check=True)
    print('wrote', relative)


def svg(ground: str | None, shape: str = 'mark') -> str:
    """The mark as SVG: coloured regions clipped to the silhouette."""
    ux0, ux1 = XL1, XR0
    left_top_y = C1[1] - (C1[2] ** 2 - (XL1 - C1[0]) ** 2) ** 0.5
    ix = (P[1] - Y[1]) / (Y[0] - P[0])
    f = lambda v: f'{v:.2f}'.rstrip('0').rstrip('.')
    silhouette = [
        # left stem
        f'M{f(XL0)} {f(C1[1])}A{f(C1[2])} {f(C1[2])} 0 0 1 {f(XL1)} {f(left_top_y)}'
        f'L{f(XL1)} {f(C2[1])}A{f(C2[2])} {f(C2[2])} 0 0 1 {f(XL0)} {f(C2[1])}Z',
        # diagonal band
        f'M{f(ux0)} {f(line_y(U, ux0))}L{f(ux1)} {f(line_y(U, ux1))}'
        f'L{f(ux1)} {f(line_y(D, ux1))}L{f(ux0)} {f(line_y(D, ux0))}Z',
        # right stem
        f'M{f(C3[0] - C3[2])} {f(C3[1])}A{f(C3[2])} {f(C3[2])} 0 0 1 {f(XR1)} {f(C3[1])}'
        f'L{f(XR1)} {f(C4[1])}A{f(C4[2])} {f(C4[2])} 0 0 1 {f(TX)} {f(TY)}'
        f'L{f(XR0)} {f(line_y(D2, XR0))}L{f(XR0)} {f(C3[1])}Z',
    ]
    fills = [
        ('green', f'M0 0H{f(XL1)}V1254H0Z'),
        ('light_green', f'M0 0H{f(XL1)}V{f(line_y(L, XL1))}L0 {f(L[1])}Z'),
        ('blue', f'M{f(XL1)} 0H{f(XR0)}V1254H{f(XL1)}Z'),
        ('yellow', f'M{f(XR0)} 0H1254V1254H{f(XR0)}Z'),
        ('deep_blue', f'M{f(XR0)} {f(line_y(Y, XR0))}L{f(ix)} {f(line_y(Y, ix))}L{f(XR0)} {f(line_y(P, XR0))}Z'),
        ('pink', f'M{f(XR0)} {f(line_y(P, XR0))}L1254 {f(line_y(P, 1254))}V1254H{f(XR0)}Z'),
    ]
    body = '\n'.join(f'    <path fill="{COLOURS[k]}" d="{d}"/>' for k, d in fills)
    clip = f'<clipPath id="nessie-n"><path d="{"".join(silhouette)}"/></clipPath>'
    group = f'  <g clip-path="url(#nessie-n)">\n{body}\n  </g>'
    if ground is None:
        # square viewBox centred on the mark
        cx = (BBOX[0] + BBOX[2]) / 2
        side = (BBOX[3] - BBOX[1]) / 0.94
        x0, y0 = cx - side / 2, (BBOX[1] + BBOX[3]) / 2 - side / 2
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{f(x0)} {f(y0)} {f(side)} {f(side)}">\n'
                f'  <defs>{clip}</defs>\n{group}\n</svg>\n')
    side = (BBOX[3] - BBOX[1]) / 0.62
    cx, cy = (BBOX[0] + BBOX[2]) / 2, (BBOX[1] + BBOX[3]) / 2
    x0, y0 = cx - side / 2, cy - side / 2
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{f(x0)} {f(y0)} {f(side)} {f(side)}">\n'
            f'  <defs>{clip}</defs>\n'
            f'  <rect x="{f(x0)}" y="{f(y0)}" width="{f(side)}" height="{f(side)}" fill="{ground}"/>\n'
            f'{group}\n</svg>\n')


def write_text(relative: str, text: str) -> None:
    (ROOT / relative).write_text(text)
    print('wrote', relative)


def main() -> None:
    # Masters
    write_text('assets/logo/nessie-mark.svg', svg(None))
    write_text('assets/logo/nessie-icon-dark.svg', svg(DARK))
    write_text('assets/logo/nessie-icon-light.svg', svg(LIGHT))
    save(mark(1024), 'assets/logo/nessie-mark-1024.png')
    save(full_bleed(1024, DARK), 'assets/logo/nessie-icon-dark-1024.png', rgb=True)
    save(full_bleed(1024, LIGHT), 'assets/logo/nessie-icon-light-1024.png', rgb=True)
    save(mac(1024), 'assets/icon-1024.png')  # desktop `tauri icon` source
    save(rounded(824), 'assets/icon-trimmed.png')  # README

    # Web: admin and marketing site share the favicon set
    for app in ('admin/public', 'web/public'):
        shutil.copyfile(ROOT / 'assets/logo/nessie-mark.svg', ROOT / app / 'favicon.svg')
        save_ico(mark, f'{app}/favicon.ico', (16, 32, 48))
        save(full_bleed(180, DARK), f'{app}/apple-touch-icon.png', rgb=True)
    save(rounded(1024), 'admin/public/icon-1024.png')
    save(rounded(192), 'admin/public/icon-192.png')
    save(rounded(512), 'admin/public/icon-512.png')
    save(render(512, 0.5, DARK), 'admin/public/icon-maskable-512.png', rgb=True)
    save(rounded(512), 'web/public/nessie-logo.png')
    # Appearance settings previews of the two phone icons
    save(full_bleed(160, LIGHT), 'admin/public/app-icon-light.png', rgb=True)
    save(full_bleed(160, DARK), 'admin/public/app-icon-dark.png', rgb=True)

    # Mobile (Expo): light is the default icon, dark the iOS alternative
    save(full_bleed(1024, LIGHT), 'mobile/assets/icon.png', rgb=True)
    save(full_bleed(1024, DARK), 'mobile/assets/icon-dark.png', rgb=True)
    save(android_foreground(1024), 'mobile/assets/adaptive-icon.png')
    save(mark(512), 'mobile/assets/splash-icon.png')
    save(mark(256), 'mobile/assets/splash-icon-rounded.png')

    # Desktop (Tauri): macOS .icns, Windows .ico and tiles, Linux PNGs
    icons = 'desktop/src-tauri/icons'
    save_icns(f'{icons}/icon.icns')
    save_ico(rounded, f'{icons}/icon.ico', (16, 24, 32, 48, 64, 256))
    for name, size in (('32x32', 32), ('64x64', 64), ('128x128', 128), ('128x128@2x', 256), ('icon', 512)):
        save(mac(size), f'{icons}/{name}.png')
    for size in (30, 44, 71, 89, 107, 142, 150, 284, 310):
        save(full_bleed(size, DARK), f'{icons}/Square{size}x{size}Logo.png')
    save(full_bleed(50, DARK), f'{icons}/StoreLogo.png')
    for density, legacy, foreground in (('mdpi', 48, 108), ('hdpi', 49, 162), ('xhdpi', 96, 216),
                                        ('xxhdpi', 144, 324), ('xxxhdpi', 192, 432)):
        folder = f'{icons}/android/mipmap-{density}'
        save(android_legacy(legacy, 'rounded'), f'{folder}/ic_launcher.png')
        save(android_legacy(legacy, 'circle'), f'{folder}/ic_launcher_round.png')
        save(android_foreground(foreground), f'{folder}/ic_launcher_foreground.png')
    write_text(f'{icons}/android/values/ic_launcher_background.xml',
               '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
               f'  <color name="ic_launcher_background">{DARK}</color>\n</resources>')
    for path in sorted((ROOT / icons / 'ios').glob('AppIcon-*.png')):
        size = Image.open(path).size[0]
        save(full_bleed(size, DARK), str(path.relative_to(ROOT)), rgb=True)

    # macOS voice companion
    appiconset = 'macos/Nessie/Assets.xcassets/AppIcon.appiconset'
    for entry in json.loads((ROOT / appiconset / 'Contents.json').read_text())['images']:
        points = int(entry['size'].split('x')[0])
        scale = int(entry['scale'][0])
        save(mac(points * scale), f'{appiconset}/{entry["filename"]}')


if __name__ == '__main__':
    main()

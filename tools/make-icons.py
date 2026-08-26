#!/usr/bin/env python3
"""
make-icons.py

Draws the Phthalo Finance app icons and writes them as real PNG files.
No image library is used: the pixels are rasterised here and the PNG is
assembled with zlib, so this runs on a plain Python install.

    python3 tools/make-icons.py

Icons are rendered once at high resolution and box filtered down to each
target size, which is what gives the smooth edges.
"""

import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')

# Straight from the palette in styles.css.
PHTHALO_700 = (0x00, 0x3D, 0x7A)
PHTHALO_500 = (0x00, 0x68, 0xB3)
PHTHALO_300 = (0x6B, 0xB3, 0xDE)
PHTHALO_050 = (0xEE, 0xF6, 0xFC)
ACCENT = (0xE0, 0xA3, 0x3D)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def dist_to_segment(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    length_sq = vx * vx + vy * vy
    if length_sq == 0:
        t = 0.0
    else:
        t = (wx * vx + wy * vy) / length_sq
        t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
    cx, cy = ax + t * vx, ay + t * vy
    dx, dy = px - cx, py - cy
    return (dx * dx + dy * dy) ** 0.5


def rounded_rect_contains(x, y, size, radius):
    """Signed containment for a rounded square covering the whole canvas."""
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    dx, dy = x - cx, y - cy
    return (dx * dx + dy * dy) ** 0.5 <= radius


def render(size, maskable=False):
    """Return a list of rows, each a list of (r, g, b, a) tuples."""
    # The chart motif, in fractions of the canvas.
    if maskable:
        # Keep everything inside the 80 percent safe zone.
        inset, scale = 0.10, 0.80
    else:
        inset, scale = 0.0, 1.0

    def fx(u):
        return (inset + u * scale) * size

    points = [(fx(0.20), fx(0.68)), (fx(0.38), fx(0.50)),
              (fx(0.52), fx(0.58)), (fx(0.79), fx(0.28))]
    stroke = size * 0.075 * (scale if maskable else 1.0)
    half = stroke / 2.0
    dot_c = points[-1]
    dot_r = size * 0.065 * (scale if maskable else 1.0)

    radius = size * 0.22
    rows = []
    for y in range(size):
        row = []
        py = y + 0.5
        for x in range(size):
            px = x + 0.5

            # Background: full bleed for maskable, rounded square otherwise.
            if maskable or rounded_rect_contains(px, py, size, radius):
                t = (px + py) / (2.0 * size)
                r, g, b = lerp(PHTHALO_700, PHTHALO_500, min(1.0, max(0.0, t)))
                a = 255
            else:
                r, g, b, a = 0, 0, 0, 0

            if a:
                # The rising line.
                best = min(dist_to_segment(px, py, points[i][0], points[i][1],
                                           points[i + 1][0], points[i + 1][1])
                           for i in range(len(points) - 1))
                if best <= half:
                    r, g, b = PHTHALO_050
                # The marker at the end of the line.
                dd = ((px - dot_c[0]) ** 2 + (py - dot_c[1]) ** 2) ** 0.5
                if dd <= dot_r:
                    r, g, b = ACCENT if dd > dot_r * 0.55 else PHTHALO_050

            row.append((r, g, b, a))
        rows.append(row)
    return rows


def downsample(rows, factor):
    size = len(rows) // factor
    out = []
    inv = 1.0 / (factor * factor)
    for y in range(size):
        row = []
        for x in range(size):
            r = g = b = a = 0
            for sy in range(factor):
                src = rows[y * factor + sy]
                for sx in range(factor):
                    p = src[x * factor + sx]
                    # Premultiply so transparent corners do not darken the edge.
                    alpha = p[3]
                    r += p[0] * alpha
                    g += p[1] * alpha
                    b += p[2] * alpha
                    a += alpha
            if a == 0:
                row.append((0, 0, 0, 0))
            else:
                row.append((round(r / a), round(g / a), round(b / a), round(a * inv)))
        out.append(row)
    return out


def write_png(path, rows):
    size = len(rows)
    raw = bytearray()
    for row in rows:
        raw.append(0)  # filter type 0
        for (r, g, b, a) in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as handle:
        handle.write(png)
    return len(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    factor = 3

    print('Rendering the standard icon...')
    big = render(512 * factor, maskable=False)

    for size in (512, 192, 180, 32):
        scaled = downsample(big, (512 * factor) // size) if (512 * factor) % size == 0 else None
        if scaled is None:
            # Render directly when the factor does not divide cleanly.
            scaled = downsample(render(size * factor, maskable=False), factor)
        name = {512: 'icon-512.png', 192: 'icon-192.png',
                180: 'apple-touch-icon.png', 32: 'favicon-32.png'}[size]
        written = write_png(os.path.join(OUT_DIR, name), scaled)
        print(f'  {name}: {size}x{size}, {written} bytes')

    print('Rendering the maskable icon...')
    mask_big = render(512 * factor, maskable=True)
    mask = downsample(mask_big, factor)
    written = write_png(os.path.join(OUT_DIR, 'icon-512-maskable.png'), mask)
    print(f'  icon-512-maskable.png: 512x512, {written} bytes')


if __name__ == '__main__':
    main()

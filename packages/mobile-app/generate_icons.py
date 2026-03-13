"""
Generate app icon assets for Mobile Copilot.
Creates icon.png (1024x1024), adaptive-icon.png (1024x1024), and splash-icon.png (512x512).
Uses the ⚡ lightning bolt concept on a dark VS Code-style background.
"""

from PIL import Image, ImageDraw, ImageFont
import os

ASSETS_DIR = os.path.join(os.path.dirname(__file__), 'assets')
os.makedirs(ASSETS_DIR, exist_ok=True)

# ─── Colors ──────────────────────────────────────────────
BG_COLOR = (30, 30, 30)         # #1e1e1e — VS Code dark
PRIMARY = (0, 120, 212)          # #0078d4 — VS Code blue
ACCENT = (78, 201, 176)          # #4ec9b0 — green accent
WHITE = (255, 255, 255)
GRADIENT_TOP = (0, 100, 180)
GRADIENT_BOT = (0, 60, 130)


def draw_rounded_rect(draw, xy, radius, fill):
    """Draw a rounded rectangle."""
    x0, y0, x1, y1 = xy
    draw.rectangle([x0 + radius, y0, x1 - radius, y1], fill=fill)
    draw.rectangle([x0, y0 + radius, x1, y1 - radius], fill=fill)
    draw.pieslice([x0, y0, x0 + 2*radius, y0 + 2*radius], 180, 270, fill=fill)
    draw.pieslice([x1 - 2*radius, y0, x1, y0 + 2*radius], 270, 360, fill=fill)
    draw.pieslice([x0, y1 - 2*radius, x0 + 2*radius, y1], 90, 180, fill=fill)
    draw.pieslice([x1 - 2*radius, y1 - 2*radius, x1, y1], 0, 90, fill=fill)


def draw_lightning_bolt(draw, cx, cy, size, color):
    """Draw a stylized lightning bolt using polygon."""
    s = size
    points = [
        (cx - s*0.15, cy - s*0.50),  # top-left
        (cx + s*0.20, cy - s*0.50),  # top-right
        (cx + s*0.05, cy - s*0.08),  # middle-right notch
        (cx + s*0.30, cy - s*0.08),  # right extension
        (cx - s*0.10, cy + s*0.50),  # bottom point
        (cx + s*0.02, cy + s*0.05),  # middle-left notch
        (cx - s*0.25, cy + s*0.05),  # left extension
    ]
    draw.polygon(points, fill=color)


def draw_code_brackets(draw, cx, cy, size, color):
    """Draw < > brackets around the bolt."""
    s = size
    width = max(int(s * 0.04), 3)
    # Left bracket <
    draw.line([(cx - s*0.40, cy), (cx - s*0.52, cy - s*0.20)], fill=color, width=width)
    draw.line([(cx - s*0.40, cy), (cx - s*0.52, cy + s*0.20)], fill=color, width=width)
    # Right bracket >
    draw.line([(cx + s*0.40, cy), (cx + s*0.52, cy - s*0.20)], fill=color, width=width)
    draw.line([(cx + s*0.40, cy), (cx + s*0.52, cy + s*0.20)], fill=color, width=width)


def create_icon(size=1024):
    """Create the main app icon."""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Rounded rectangle background
    margin = int(size * 0.02)
    radius = int(size * 0.18)
    draw_rounded_rect(draw, (margin, margin, size - margin, size - margin), radius, BG_COLOR)

    # Subtle gradient overlay (top portion)
    for y in range(margin, size // 3):
        alpha = int(30 * (1 - (y - margin) / (size / 3 - margin)))
        draw.line([(margin + radius, y), (size - margin - radius, y)],
                  fill=(PRIMARY[0], PRIMARY[1], PRIMARY[2], alpha))

    # Draw lightning bolt centered
    cx, cy = size // 2, size // 2
    bolt_size = size * 0.55

    # Shadow
    draw_lightning_bolt(draw, cx + 4, cy + 6, bolt_size, (0, 0, 0, 80))

    # Main bolt
    draw_lightning_bolt(draw, cx, cy, bolt_size, WHITE)

    # Draw code brackets
    draw_code_brackets(draw, cx, cy, bolt_size, ACCENT)

    return img


def create_adaptive_icon(size=1024):
    """Create Android adaptive icon foreground (no background rounding — Android handles it)."""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Adaptive icons need safe zone padding (18.75% on each side, use ~20%)
    padding = int(size * 0.20)
    inner = size - 2 * padding
    cx, cy = size // 2, size // 2

    bolt_size = inner * 0.55

    # Bolt
    draw_lightning_bolt(draw, cx, cy, bolt_size, WHITE)
    draw_code_brackets(draw, cx, cy, bolt_size, ACCENT)

    return img


def create_splash_icon(size=512):
    """Create splash screen icon."""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    cx, cy = size // 2, size // 2
    bolt_size = size * 0.65

    # Bolt
    draw_lightning_bolt(draw, cx, cy, bolt_size, PRIMARY)
    draw_code_brackets(draw, cx, cy, bolt_size, ACCENT)

    return img


if __name__ == '__main__':
    print('Generating app icon assets...')

    icon = create_icon(1024)
    icon.save(os.path.join(ASSETS_DIR, 'icon.png'), 'PNG')
    print('  ✓ icon.png (1024x1024)')

    adaptive = create_adaptive_icon(1024)
    adaptive.save(os.path.join(ASSETS_DIR, 'adaptive-icon.png'), 'PNG')
    print('  ✓ adaptive-icon.png (1024x1024)')

    splash = create_splash_icon(512)
    splash.save(os.path.join(ASSETS_DIR, 'splash-icon.png'), 'PNG')
    print('  ✓ splash-icon.png (512x512)')

    # Also create a favicon for the web version
    favicon = icon.resize((48, 48), Image.LANCZOS)
    favicon.save(os.path.join(ASSETS_DIR, 'favicon.png'), 'PNG')
    print('  ✓ favicon.png (48x48)')

    print('Done! Assets saved to', ASSETS_DIR)

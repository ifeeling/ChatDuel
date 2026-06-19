from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "store" / "assets"
OUT.mkdir(parents=True, exist_ok=True)

INK = "#171a1f"
PAPER = "#f7f5ef"
SHEET = "#fffdf8"
LINE = "#d9d2c3"
MUTED = "#606874"
BLUE = "#183b73"
GREEN = "#14725c"
GREEN_SOFT = "#dff0e9"
YELLOW = "#f2c96d"
BLUE_SOFT = "#e8eef8"

FONT_DIR = Path("/System/Library/Fonts/Supplemental")
GEORGIA_BOLD = str(FONT_DIR / "Georgia Bold.ttf")
ARIAL = str(FONT_DIR / "Arial.ttf")
ARIAL_BOLD = str(FONT_DIR / "Arial Bold.ttf")


def font(path, size):
    return ImageFont.truetype(path, size)


def draw_grid(draw, width, height, step=48, strength="normal"):
    if strength == "none":
        return
    vertical_color, horizontal_color = {
        "normal": ("#5f625f", "#d9d2c3"),
        "light": ("#e6e0d4", "#eee9de"),
    }.get(strength, ("#5f625f", "#d9d2c3"))
    for x in range(0, width, step):
        draw.line([(x, 0), (x, height)], fill=vertical_color, width=1)
    for y in range(0, height, step):
        draw.line([(0, y), (width, y)], fill=horizontal_color, width=1)


def draw_logo(draw, x, y, size):
    shadow = max(3, size // 10)
    draw.rectangle([x + shadow, y + shadow, x + size + shadow, y + size + shadow], fill=INK)
    draw.rectangle([x, y, x + size, y + size], fill=YELLOW, outline=INK, width=max(2, size // 16))

    cx = x + size / 2
    cy = y + size / 2
    scale = size / 64

    left = [
        (cx - 5 * scale, cy - 18 * scale),
        (cx - 17 * scale, cy - 11 * scale),
        (cx - 20 * scale, cy),
        (cx - 17 * scale, cy + 11 * scale),
        (cx - 5 * scale, cy + 18 * scale),
        (cx + 1 * scale, cy + 10 * scale),
        (cx - 8 * scale, cy + 5 * scale),
        (cx - 10 * scale, cy),
        (cx - 8 * scale, cy - 5 * scale),
        (cx + 1 * scale, cy - 10 * scale),
    ]
    right = [(2 * cx - px, py) for px, py in left]
    diamond = [
        (cx, cy - 9 * scale),
        (cx + 9 * scale, cy),
        (cx, cy + 9 * scale),
        (cx - 9 * scale, cy),
    ]
    draw.polygon(left, fill=INK)
    draw.polygon(right, fill=INK)
    draw.polygon(diamond, fill=YELLOW)


def text(draw, xy, value, font_obj, fill=INK, spacing=4):
    draw.multiline_text(xy, value, font=font_obj, fill=fill, spacing=spacing)


def panel(draw, box, title, lines=3, accent=None, title_size=20):
    x1, y1, x2, y2 = box
    draw.rectangle(box, fill=SHEET, outline=INK, width=3)
    if accent:
        draw.rectangle([x1, y1, x2, y1 + 12], fill=accent)
    draw.text((x1 + 18, y1 + 24), title, font=font(ARIAL_BOLD, title_size), fill=BLUE)
    for i in range(lines):
        y = y1 + 62 + i * 24
        w = int((x2 - x1 - 52) * (0.95 - i * 0.16))
        draw.rounded_rectangle([x1 + 18, y, x1 + 18 + w, y + 9], radius=2, fill="#ddd8ce")


def draw_workspace(draw, x, y, scale=1.0, compact=False):
    w = int(205 * scale)
    h = int(150 * scale)
    gap = int(12 * scale)
    title_size = 16 if compact else 20
    panel(draw, [x, y, x + w, y + h], "AI A", lines=3, accent=YELLOW, title_size=title_size)
    panel(draw, [x + w + gap, y + int(20 * scale), x + 2 * w + gap, y + h + int(20 * scale)], "AI B", lines=3, accent=BLUE_SOFT, title_size=title_size)
    panel_title = "" if compact else "Consensus"
    panel(draw, [x + int(0.5 * w), y + h + int(32 * scale), x + int(1.5 * w), y + h + int(108 * scale)], panel_title, lines=1, accent=GREEN_SOFT, title_size=title_size)
    cx = x + w + gap // 2
    cy = y + h + int(16 * scale)
    d = int(20 * scale)
    draw.polygon([(cx, cy - d), (cx + d, cy), (cx, cy + d), (cx - d, cy)], fill=GREEN, outline=INK)
    for dx in [-42, 0, 42]:
        draw.line([(cx + dx * scale, cy - 46 * scale), (cx + dx * scale, cy - 66 * scale)], fill=YELLOW, width=max(4, int(5 * scale)))


def variant_suffix(grid_strength):
    return {
        "normal": "",
        "light": "-light-lines",
        "none": "-no-lines",
    }[grid_strength]


def small_tile(grid_strength="normal"):
    img = Image.new("RGB", (440, 280), PAPER)
    draw = ImageDraw.Draw(img)
    draw_grid(draw, 440, 280, 40, grid_strength)
    draw.line([(0, 246), (440, 246)], fill=INK, width=3)

    draw_logo(draw, 28, 26, 54)
    draw.text((98, 27), "ChatDuel", font=font(ARIAL_BOLD, 26), fill=INK)
    text(draw, (30, 108), "Compare AI\nanswers side\nby side", font(GEORGIA_BOLD, 34), fill=INK, spacing=1)
    draw.rectangle([30, 222, 172, 252], fill=YELLOW, outline=INK, width=2)
    draw.text((42, 227), "No API keys", font=font(ARIAL_BOLD, 15), fill=INK)

    draw_workspace(draw, 248, 48, 0.36, compact=True)
    draw.rectangle([246, 194, 406, 238], fill=GREEN_SOFT, outline=GREEN, width=2)
    draw.text((260, 205), "Consensus first", font=font(ARIAL_BOLD, 15), fill="#0e4e3e")
    img.save(OUT / f"chrome-small-promo-440x280{variant_suffix(grid_strength)}.png")


def marquee_tile(grid_strength="normal"):
    img = Image.new("RGB", (1400, 560), PAPER)
    draw = ImageDraw.Draw(img)
    draw_grid(draw, 1400, 560, 48, grid_strength)
    draw.line([(0, 500), (1400, 500)], fill=INK, width=4)

    draw_logo(draw, 78, 62, 76)
    draw.text((178, 72), "ChatDuel", font=font(ARIAL_BOLD, 36), fill=INK)
    text(draw, (82, 190), "Consensus first.\nDecide with more\nconfidence.", font(GEORGIA_BOLD, 68), fill=INK, spacing=4)
    draw.text((86, 424), "Compare AI answers side by side. No API keys.", font=font(ARIAL, 25), fill=MUTED)

    draw.rectangle([86, 474, 250, 512], fill=YELLOW, outline=INK, width=2)
    draw.text((104, 482), "No API keys", font=font(ARIAL_BOLD, 20), fill=INK)
    draw.rectangle([270, 474, 468, 512], fill=SHEET, outline=INK, width=2)
    draw.text((288, 482), "Local records", font=font(ARIAL_BOLD, 20), fill=BLUE)

    draw_workspace(draw, 772, 122, 0.98)
    draw.rectangle([840, 420, 1174, 478], fill=GREEN_SOFT, outline=GREEN, width=3)
    draw.text((872, 436), "Consensus, next steps", font=font(ARIAL_BOLD, 22), fill="#0e4e3e")
    img.save(OUT / f"chrome-marquee-promo-1400x560{variant_suffix(grid_strength)}.png")


if __name__ == "__main__":
    for strength in ["normal", "light", "none"]:
        small_tile(strength)
        marquee_tile(strength)
        print(OUT / f"chrome-small-promo-440x280{variant_suffix(strength)}.png")
        print(OUT / f"chrome-marquee-promo-1400x560{variant_suffix(strength)}.png")

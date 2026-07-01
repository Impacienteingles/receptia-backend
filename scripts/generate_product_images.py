import os
import shutil
from PIL import Image, ImageDraw, ImageFont, ImageFilter

def create_product_image(plan_name, color_start, color_end, label_text, filename):
    # Dimensions
    size = 600
    img = Image.new("RGBA", (size, size), (15, 23, 42, 255)) # Dark slate base
    draw = ImageDraw.Draw(img)

    # 1. Create a beautiful gradient background
    for y in range(size):
        # Blend from color_start at the top to color_end at the bottom
        r = int(color_start[0] + (color_end[0] - color_start[0]) * (y / size))
        g = int(color_start[1] + (color_end[1] - color_start[1]) * (y / size))
        b = int(color_start[2] + (color_end[2] - color_start[2]) * (y / size))
        draw.line([(0, y), (size, y)], fill=(r, g, b, 255))

    # 2. Draw a glowing ring in the center
    center = size // 2
    ring_radius = 160
    
    # Outer soft glow ring (blurred)
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse(
        [center - ring_radius - 10, center - ring_radius - 10, center + ring_radius + 10, center + ring_radius + 10],
        outline=(color_start[0], color_start[1], color_start[2], 120),
        width=16
    )
    glow = glow.filter(ImageFilter.GaussianBlur(15))
    img.alpha_composite(glow)

    # Crisp inner ring
    draw.ellipse(
        [center - ring_radius, center - ring_radius, center + ring_radius, center + ring_radius],
        outline=(255, 255, 255, 60),
        width=2
    )

    # 3. Load and paste the new Receptia Logo in the center
    logo_path = '/Users/juanpablo/Desktop/APPS/Receptia/public/receptia_logo.png'
    if os.path.exists(logo_path):
        logo = Image.open(logo_path).convert("RGBA")
        # Resize logo
        logo_size = 220
        logo = logo.resize((logo_size, logo_size), Image.Resampling.LANCZOS)
        
        # Round the logo corners or mask it to be circular
        mask = Image.new("L", (logo_size, logo_size), 0)
        mask_draw = ImageDraw.Draw(mask)
        mask_draw.ellipse([0, 0, logo_size, logo_size], fill=255)
        
        logo_x = center - (logo_size // 2)
        logo_y = center - (logo_size // 2) - 30 # Lift slightly to leave room for text
        
        img.paste(logo, (logo_x, logo_y), mask)

    # 4. Add beautiful text labels
    # Look for Helvetica or fallback to default
    font_paths = [
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf"
    ]
    font = None
    for path in font_paths:
        if os.path.exists(path):
            try:
                font = ImageFont.truetype(path, 34)
                break
            except:
                pass
    if not font:
        font = ImageFont.load_default()

    # Draw text with nice spacing
    text_y = center + 120
    
    # Text shadow/glow
    shadow_offset = 2
    draw.text((center, text_y + shadow_offset), label_text, fill=(0, 0, 0, 180), font=font, anchor="mm")
    
    # White crisp text
    draw.text((center, text_y), label_text, fill=(255, 255, 255, 240), font=font, anchor="mm")

    # Save the final image as PNG in public/
    public_path = os.path.join('/Users/juanpablo/Desktop/APPS/Receptia/public', filename)
    img.convert("RGB").save(public_path, "PNG")
    print(f"✅ Generated product image at {public_path}")

    # Also copy to dist/public/
    dist_public_dir = '/Users/juanpablo/Desktop/APPS/Receptia/dist/public'
    if os.path.exists(dist_public_dir):
        dist_path = os.path.join(dist_public_dir, filename)
        shutil.copy2(public_path, dist_path)
        print(f"✅ Copied to {dist_path}")

# Run generator for the 4 product banners
create_product_image("Plan Inicial", (30, 64, 175), (15, 23, 42), "PLAN INICIAL", "stripe_inicial.png")
create_product_image("Plan Estandar", (124, 58, 237), (15, 23, 42), "PLAN ESTÁNDAR", "stripe_estandar.png")
create_product_image("Plan Premium", (217, 119, 6), (15, 23, 42), "PLAN PREMIUM", "stripe_premium.png")
create_product_image("Minutos Adicionales", (5, 150, 105), (15, 23, 42), "MINUTOS EXTRA", "stripe_minutos.png")

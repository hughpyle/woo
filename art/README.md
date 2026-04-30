# art/ — brand source assets

Source images. Not shipped. Build derivatives into `public/` for the SPA bundle.

## Files

- `cockatoo.png` — master illustration (1254×1254, riso-style sulphur-crested cockatoo).
- `head-crop.png` — square crop of the head + crest, used as the favicon source.

## Regenerating shipped derivatives

```sh
# Favicon sizes (head + crest crop, lossless Lanczos resize)
for sz in 16 32 48 64 96 180; do
  magick art/head-crop.png -filter Lanczos -resize ${sz}x${sz} \
    public/icons/favicon-${sz}.png
done

# OG image (1200×630, paper bg + bird left + wordmark right)
PAPER="#fefaf3"; INK="#2a5e66"; ACCENT="#cc933e"
GEORGIA_IT="/System/Library/Fonts/Supplemental/Georgia Italic.ttf"
GEORGIA="/System/Library/Fonts/Supplemental/Georgia.ttf"
magick -size 1200x630 xc:"$PAPER" \
  \( art/cockatoo.png -trim +repage -resize x580 \) \
    -gravity West -geometry +40+0 -composite \
  -font "$GEORGIA_IT" -pointsize 240 -fill "$ACCENT" \
    -gravity NorthWest -annotate +680+170 "woo" \
  -font "$GEORGIA" -pointsize 32 -fill "$INK" \
    -gravity NorthWest -annotate +685+410 "persistent objects" \
  -font "$GEORGIA" -pointsize 32 -fill "$INK" \
    -gravity NorthWest -annotate +685+450 "all the way down" \
  public/og-image.png
```

## Palette

- Paper: `#fefaf3` (warm cream, sampled from `cockatoo.png`)
- Ink (outlines, tagline): `#2a5e66` (riso teal)
- Accent (wordmark, crest highlights): `#cc933e` (riso amber)

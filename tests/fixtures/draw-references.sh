#!/bin/sh
# Draws the reference fixtures and their format variants (see README.md).
# Run from tests/fixtures; requires ImageMagick 7 with AVIF support.
set -e
png='-strip -define png:exclude-chunks=date,time'

# A pink vase on a blush ground.
magick -size 146x196 gradient:'#f7e1e5-#eab8c3' -fill '#d4677f' -draw 'roundrectangle 60,52 87,96 6,6' -draw 'ellipse 73,132 42,48 0,360' \
  -fill '#e9899c' -draw 'ellipse 60,120 10,22 0,360' -fill '#b9506a' -draw 'ellipse 73,52 15,5 0,360' $png reference-pink.png
# A clear glass on a pale blue ground.
magick -size 144x176 gradient:'#eef4f7-#cfdfe8' -fill '#bcd6e4c0' -stroke '#8fb3c8' -strokewidth 2 -draw 'polygon 44,40 101,40 92,146 53,146' \
  -fill '#ffffff00' -draw 'ellipse 72,40 29,7 0,360' -stroke none -fill '#ffffffb0' -draw 'roundrectangle 54,52 60,128 3,3' \
  -fill '#9ec3d6' -draw 'ellipse 72,146 20,4 0,360' $png reference-glass.png
# Citrus slices on a warm ground.
magick -size 142x198 gradient:'#fdf0c8-#f6d991' -fill '#f6b04a' -draw 'circle 62,84 62,124' -fill '#fbd27a' -draw 'circle 62,84 62,118' \
  -stroke '#f6b04a' -strokewidth 2 -draw 'line 62,50 62,118' -draw 'line 28,84 96,84' -draw 'line 38,60 86,108' -draw 'line 86,60 38,108' \
  -stroke none -fill '#e8892e' -draw 'circle 94,148 94,178' -fill '#f4a640' -draw 'circle 94,148 94,173' $png reference-citrus.png
# A red flower on a sage ground.
magick -size 144x178 gradient:'#e6eedf-#c9d8bd' -stroke '#5d8a4e' -strokewidth 4 -draw 'line 72,96 72,172' -stroke none -fill '#6f9a5c' -draw 'ellipse 88,140 16,7 -30,360' \
  -fill '#df5a4e' -draw 'circle 72,58 72,80' -draw 'circle 50,74 50,94' -draw 'circle 94,74 94,94' -draw 'circle 58,98 58,116' -draw 'circle 86,98 86,116' \
  -fill '#f3c34f' -draw 'circle 72,82 72,94' $png reference-flower.png

magick reference-glass.png -resize 32x32 -strip -write source-image.jpg -write source-image.webp -write source-image.avif -write source-image.bmp source-image.ico

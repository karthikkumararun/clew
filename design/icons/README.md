# Clew app icon

The SVG files here are the only source of truth. `pnpm icons` renders every platform asset from them
(`src-tauri/icons/**`, `src/components/ClewMark.tsx`); never edit a generated file. The design is
`design/canvas/AppIcon.dc.html`.

## Files

| File                     | Use                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `clew-icon.svg`          | macOS master (1024 canvas, 824 px body, 100 px margin, baked shadow and highlight)       |
| `clew-icon-windows.svg`  | Windows master (928 px body, 48 px margin, no shadow); also the PNG set and Store logos  |
| `clew-icon-small.svg`    | Every raster below 48 px (16, 20, 24, 30, 32, 40, 44): redrawn, not scaled               |
| `clew-mark.svg`          | One-colour in-app mark (`currentColor`), becomes `ClewMark`                              |
| `golden/*.png`           | Approved renders at 16, 32, 64, 256, 1024; `pnpm icons --update-golden`, then review     |

## Palette

Ground `#1B2028` `#0F1217` `#14171C`; gold `#F2C070` `#E3A64F` `#C58633`; white and black only as
mask values or at low opacity. The dev badge adds `#7FC8F8`. Gold on strand contrast is at least 7:1.
`pnpm check:icons` rejects any other colour.

## Clear space and minimum size

- macOS: keep the 100 px transparent margin (a 1024 canvas); do not enlarge the body.
- Windows: keep the 48 px margin.
- Smallest use: 16 px with `clew-icon-small.svg`. The mark is for 16 px and up; below that, use the icon.

## Don't

- Recolour the ball, thread or ground, or add a light variant (the icon carries its own dark ground).
- Add outlines, glows or extra effects; the shadow on the macOS master is part of the artwork.
- Place the mark on a gold background (no contrast), or attach the thread at the ball's lower right
  (it reads as the letter Q).
- Scale the master down for small sizes; the generator picks the artwork by size.

## Dev builds

`pnpm dev:app` runs `tauri dev` with `src-tauri/tauri.dev.conf.json`, which selects `icons/dev/*`:
the same artwork with a blue DEV pill. Release bundles never use them.

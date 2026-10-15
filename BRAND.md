# shill brand

| | |
| --- | --- |
| Name | shill (wordmark always lowercase) |
| Ticker | $SHILL |
| Pitch | your repo's shill. commits in, posts out. |
| npm package / CLI | `shill` / `shill` |

The look is a soft creator tool: blush paper, white cards, one hot pink. It should
feel closer to a post scheduler than to a terminal.

## The icon and the mark

A flat white megaphone with two sound waves on a hot pink tile. **Meaning in one
sentence: shill is the megaphone for your repo, commits go in the back and posts come
out the front.**

Everything is flat: no 3D, no shadows on the icon, no gradients.

Files in `assets/`:

- `icon.png`: 512px app icon, rounded tile (README header, docs, nav, banner).
- `coin.png`: 1000x1000 full-bleed tile, the $SHILL token image. Reads cropped to a circle.
- `logo.svg`: the megaphone alone in `#FF2E8B`, square viewBox. Favicons and small sizes.
- `logo-mono.svg`: the same in `currentColor`, for one-colour use.
- `banner.png` (source `banner.html`): 1280x640 GitHub social preview, light.
- `terminal.svg`: a real run against the test fixtures, light theme, Space Mono embedded.
- `dashboard.png`: `shill ui` against the mock GitHub server.

## Palette

| Role | Hex |
| --- | --- |
| Background (blush) | `#FFF5F8` |
| Cards | `#FFFFFF` |
| Raised (segmented controls, chips, avatars) | `#FFEAF1` |
| Lines, 1px borders | `#F6D9E3` |
| Text (ink) | `#2A1420` |
| Muted text | `#8E6C7B` |
| Accent: the main action, the key number, the icon tile | `#FF2E8B`, white text on it |
| Second colour, used rarely (links inside post previews, "first commit") | `#7C5CFF` |

Shadows are soft and pink: `0 8px 24px rgba(255,46,139,.10)`. Borders are 1px.
One accent per view: the main button and the next version number.

## Typography

- **Plus Jakarta Sans** 500, 700 and 800 for UI and headings. Headings at 800 with
  tracking `-0.03em`.
- **Space Mono** 400 and 700 for code, counts, versions and every number (tabular).
- Wordmark: `shill` in Plus Jakarta Sans 800, lowercase, tracking `-0.05em` at large sizes.
- The woff2 files ship in `src/fonts/` (dashboard) and `docs/fonts/` (landing page).

## Shape

- Cards 20px radius, inputs 12px, buttons and chips are pills.
- Spacing scale 4, 8, 12, 16, 24, 32, 48, 64.
- Drafts are always shown as real post previews (X, Discord, Telegram, LinkedIn).
- On shillcli.com the tool is the hero: one input, one pink button, results right under it.
  Example data is always labelled as example data.

## Logo usage

- Use `icon.png` at 32px and up. Below 32px use `logo.svg`.
- Keep clear space around the icon of at least a quarter of its width.
- Do not recolour the tile, add shadows or effects, stretch or rotate.
- On dark backgrounds use the icon as is or the mark in white.
- In a lockup the wordmark sits right of the icon, vertically centred, in ink `#2A1420`.

## Voice

- Talk like a dev posting on CT: lowercase is fine, short sentences, no press release.
- Say what it does with a number when you can: "5 channels, each under its limit."
- Honest: example data is labelled, no invented users or stars, no hype words, no dashes.

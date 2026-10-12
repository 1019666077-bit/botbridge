# Bot Bridge logo pack

Marks for the Bot Bridge publisher and its four products. Companion artwork for Grok Bot and remote-bot tooling.

Same family on every tile: a deep navy / indigo rounded square, white structure, cyan accent. Geometry only — no wordmarks.

| Mark | What it shows | SVG | 128 | 512 |
| --- | --- | --- | --- | --- |
| Publisher | Bridge arch linking three bot nodes | [publisher.svg](publisher.svg) | [publisher-128.png](publisher-128.png) | [publisher-512.png](publisher-512.png) |
| CC Helper | Terminal and prompt, for dispatching Claude Code | [cc-helper.svg](cc-helper.svg) | [cc-helper-128.png](cc-helper-128.png) | [cc-helper-512.png](cc-helper-512.png) |
| Webcam Bridge | Camera with a cyan lens | [webcam.svg](webcam.svg) | [webcam-128.png](webcam-128.png) | [webcam-512.png](webcam-512.png) |
| Obsidian Bridge | Vault note with a folded corner | [obsidian.svg](obsidian.svg) | [obsidian-128.png](obsidian-128.png) | [obsidian-512.png](obsidian-512.png) |
| App Bridge | Overlapping windows (list, read UI text, screenshot) | [app-bridge.svg](app-bridge.svg) | [app-bridge-128.png](app-bridge-128.png) | [app-bridge-512.png](app-bridge-512.png) |

A contact sheet of the set is in [preview/sheet.png](preview/sheet.png).

## Usage

- **Visual Studio Marketplace publisher logo:** [`publisher-128.png`](publisher-128.png).
- **Extension icon** (`package.json` `"icon"`): the product’s `*-128.png`.
- **Site favicon and Open Graph:** start from the matching `*-512.png`. Scale down from 512. Do not enlarge the 128.

Corners outside the rounded square are transparent. The navy tile is part of the mark.

## Source

Each SVG is hand-authored and is the source of truth. The PNGs are rasterized from that SVG with [sharp](https://sharp.pixelplumbing.com/) at 128×128 and 512×512. They are not resized photographs or JPEG exports.

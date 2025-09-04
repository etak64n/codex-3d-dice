# 3D Dice (Three.js + Rapier)

This is a 3D dice demo powered by Three.js and Rapier. It features PBR‑styled dice, physics‑based rolling, and a casino‑inspired table and background with a soft bokeh look. The UI is intentionally minimal: a full‑screen canvas you can tap/click.

This project was fully generated using CODEX (Codex CLI).

## Features
- PBR 6‑sided dice (rounded box + sticker faces)
- Rapier physics (floor, walls, ceiling, and tray rails) for natural rolling and settling
- Casino‑style felt, wood base, oxblood leather rails, and subtle gold trim
- Bright, warm bokeh background (generated via CanvasTexture)
- Reroll anytime: pointerdown triggers a roll even while it’s running

## Requirements
- Node.js 18+ (uses Vite 5)
- Modern browser: latest Chrome / Edge / Safari

## Setup
```bash
npm install
```

## Development
```bash
npm run dev
```
- Starts the Vite dev server (default http://localhost:5173)
- Hot reload on save

## Build & Preview
```bash
npm run build    # emits to dist/
npm run preview  # serve the production build locally
```
- Deploy the `dist/` folder to any static host.

## Controls
- Click/Tap inside the canvas: roll (works even while rolling)
- Space key: roll

## Key Files
- `index.html`: Full‑screen canvas and entry point
- `src/main.ts`: Scene setup, physics, input, render loop, and visuals

## Implementation Notes (Tuning)
- Physics (fall and energy)
  - Gravity: `new RAPIER.World({ y: -16.0 })`
  - Start height: `PHYS.startY = 3.0`
  - Immediate re‑roll: pointerdown always triggers a new roll and resets settle counters
  - Fixed timestep (`PHYS.worldHz`) with sub‑stepping to follow real time
- Containment
  - Visible wooden tray rails are also colliders (keeps dice on the felt)
  - Soft bounds `BOUNDS` gently nudge dice back inside if they drift out
- Look (materials / background)
  - Dice: `MeshPhysicalMaterial` with micro‑roughness/bump; tuned to avoid highlight clipping
  - Stickers: transparent background textures (pips only) to match the die body’s white
  - Felt / wood / leather: generated `CanvasTexture` with tweakable color/roughness
  - Background: bright warm gradient + bokeh circles, vignette disabled
- Brightness (avoid blown highlights)
  - Adjust `renderer.toneMappingExposure` (e.g., 1.35–1.50)
  - If highlights clip, increase material `roughness`, and slightly reduce `clearcoat`, `envMapIntensity`, or `specularIntensity`

## License
- Code in this repository may be used for project purposes. Third‑party dependencies remain under their respective licenses.

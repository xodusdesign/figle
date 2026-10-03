# Figle — a Figma preview plugin for Eagle

Preview local Figma files (`.fig`, `.jam`, `.deck`) directly inside [Eagle](https://www.eagle.cool) — thumbnails in the library grid + a rich viewer with cover art and file metadata. Fully offline, no Figma token needed.

## How it works

Modern `.fig` / `.jam` / `.deck` files are plain **ZIP archives (STORE mode)** containing:

| Entry | Used for |
|---|---|
| `thumbnail.png` | Grid thumbnail + viewer cover (the exact preview Figma ships in the file) |
| `meta.json` | Document title, background, export date |
| `canvas.fig` | Size + `fig-kiwi` magic / version line in the viewer |
| `images/*` | Embedded fill-bitmap count |

Legacy pre-ZIP `.fig` files carry a trailing PNG instead — the plugin scans the binary for the largest embedded PNG. If no cover exists (or the file is corrupt), it still generates a branded placeholder so your library never shows a broken tile. Everything is dependency-free (Node built-ins only), so it runs in Eagle's thumbnail sandbox.

## Install (local, 1 min)

1. Open **Eagle → Plugin → Developer Options → Import Plugin** (or drag-and-drop the folder).
2. Select this `eagle plugin` folder (the one containing `manifest.json`).
3. Drop a `.fig` file into Eagle — you should see its cover as the thumbnail.
4. Double-click / Spacebar-preview the file to open the viewer (cover, metadata, **Open in Figma** button).

## Package for sharing / store

```bash
# from the folder containing manifest.json:
zip -r Figle.eagleplugin manifest.json logo.png js/ thumbnail/ viewer/ README.md
```

Then **Eagle → Plugin → Import** the `.eagleplugin` file, or submit it to the plugin center.

## Test without Eagle

```bash
node -e "
(async()=>{
  const t = require('./thumbnail/fig.js');
  console.log(await t({src:'/path/to/file.fig', dest:'/tmp/out.png', item:{}}));
})()"
```

## Limitations (honest)

- Full canvas rendering (editable layers, vectors, text) is **not** possible outside Figma — `canvas.fig` is a closed `fig-kiwi` binary with an embedded schema that changes between releases. This plugin shows the authoritative embedded cover + metadata, which is the most Eagle can do offline.
- To edit: click **Open in Figma** (or File → Open in Figma Desktop).
- Format-extension plugins don't get the Eagle Plugin API or DevTools (Eagle platform limit) — that's why thumbnail/viewer use plain Node + inline HTML.

## Files

```
manifest.json        — plugin id, preview block for fig,jam,deck
logo.png             — plugin icon
js/fig-utils.js      — ZIP-STORE reader, PNG scan, placeholder PNG (shared)
thumbnail/fig.js     — Eagle entry: {src,dest,item} → writes PNG thumbnail
viewer/fig.html      — Eagle entry: ?path=&theme= → cover + metadata + actions
```

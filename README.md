# S.P.L.U.R.T. Station Atlas

A static, zoomable map of [S.P.L.U.R.T.](https://github.com/SPLURT-Station/S.P.L.U.R.T-tg) stations. Node.js scripts acquire a pinned source checkout, parse BYOND DMM/TGM maps and DM declarations, decode DMI sprite sheets, and bake browser-ready WebP tiles. The deployed app needs no server, database, BYOND installation or API key.

## Run locally

Requires Node.js 22+ (24 recommended), pnpm 10.28 and Git. From this directory:

```powershell
pnpm install
pnpm source
pnpm export
pnpm dev
```

Open the local URL printed by Vite (normally http://127.0.0.1:5173). This delivered folder already has its own source checkout and exported station data, so `pnpm dev` is sufficient to start exploring. `pnpm build` produces the ready-to-host `dist/` folder; `pnpm preview` serves that build locally. Serve over HTTP, rather than opening `index.html` with `file://`, because the viewer fetches map data and runs a worker.

To seed a fresh project from an existing checkout, without modifying it:

```powershell
pnpm source --from ../S.P.L.U.R.T-tg
```

The project owns its checkout under `.source/S.P.L.U.R.T-tg/`. A local clone reuses Git objects with hard links when available; working files are independent. To retrieve everything from GitHub instead, omit `--from`. The initial source acquisition can be large; the game includes extensive art and audio. `.source`, dependencies, generated maps and build output are ignored by Git.

## Explore

- Opening the page without a map fragment shows a station picker. All **16 station configurations** are available, covering Tramstation, NorthStar, Ice Box, Blueshift, Moon Station and the other configured stations. Minimal Runtime Station, Runtime Station, MultiZ Debug and Gateway Test are excluded in `excludeMaps`. Deck numbers are source-local DMM Z coordinates, not live server Z assignments.
- Drag to pan; scroll, pinch, double-click or use **+ / −** to zoom. **F** fits the station. Arrow keys pan. **/** focuses search. **Escape** closes the inspector.
- **Look through decks** reveals lower levels through space, open-space, glass floors, catwalks and transparent sprite edges. Surfaces compose from bottom to top, so an intervening opaque deck blocks deeper decks. Glass has partial visibility. Ordinary air above an opaque floor does not create a hole.
- The sidebar has **Map & layers**, **Search**, and **Selected tile** tabs. Collapse it with the arrow or drag its right edge to resize it; the width is remembered on this device. Double-click the resize grip to reset the width. Zoom/fit controls float at the bottom right, and deck controls at the top right.
- The tile inspector defaults to readable descriptions: the room and surface, objects present, possible random finds, deck connections, and normal door-access roles. **Detailed view**, off by default, exposes type paths, overrides and source links. Every door shows both who can open it and who cannot, using normal starting IDs. Door access uses starting job ID trims and mapped access helpers; expanded department access is listed separately. Remotely controlled doors and unresolved dynamic rules are labeled instead of being called public.
- **Animated parallax** projects lower decks at increasing distances from the camera, so they recede and move independently when panning. Three star fields drift continuously at different speeds over a moving nebula on a separate background canvas. The motion toggle pauses the animation and removes depth perspective. Reduced-motion preferences disable it by default; animation pauses in hidden tabs.
- Independently toggle **atmospherics**, **power**, **waste disposal**, and **transit tubes**. Transit tubes are **on by default**. Utility layers show only on the viewed deck. Cables and smart pipes use connecting sprites derived from their mapped neighbors, layers and blocked directions. **Simple utility symbols** replaces power/atmospheric sprites with lightweight crosses.
- **Color separate power networks** gives each connected cable component a distinct color. The graph accounts for cable layers, blocked links, multi-Z hubs and the normal SMES input/output separation. This describes mapped wired connectivity, not whether a network is energized during a round.
- **Highlight stairs & ladders** marks mapped deck connections with gently pulsing circles (static with reduced motion); **Show where stairs & ladders lead** adds an arrow in the center of each tile: up, down, or both directions. Arrows and highlights appear only on the viewed deck. Destination decks and rooms remain in the tile inspector; unresolved destinations have no direction arrow.
- **Replace runtime-generated turfs** is on by default. Bright green/blue/orange mapper placeholders are replaced visually with the area's representative terrain: snow/ice on Ice Box and appropriate lunar or volcanic ground on Moon Station. Deterministic sprite variants blend with the surrounding terrain. Turn it off to inspect the original placeholders. This is a terrain preview, not a reconstruction of a particular round's procedural seed; mapped objects, room metadata and original turf types are preserved.
- **Room boundaries** adds stable region colors, boundaries, and room labels when zoomed in. Click a tile for the area path, region, turf, placed objects, variable overrides, and links to the pinned game source. Opaque pixels cover lower decks; transparent sprite edges preserve visibility rather than cutting a whole tile out of the view.
- Search room names, item names or full DM paths across all decks. Bundled **Fuse.js** performs fuzzy search offline in a worker, tolerating misspellings such as `wernch`. **Placed** means a directly mapped `/obj/item`; **Possible** means a statically discoverable loot-table candidate. Results group the same item and spawn classification together, deduplicating coordinates across spawners. Selecting a result uses the normal tile inspector, briefly pulses the selected tile, and lists every distinct finding by room, deck and coordinates. The list has 30 locations per page, with every page accessible; matching tiles are marked on the current deck. The result list shows the first 70 ranked groups and reports the total.
- The compact URL fragment stores the station (`m`), deck (`z`), camera (`x`,`y`), zoom (`s`), selected tile (`t=X,Y,Z`), query (`q`), grouped result (`r`) and one-based finding number (`f`). Sidebar toggles, including search filters, detailed view, are packed into the decimal bitmask `o`. Links restore the same options and selection. Only these compact keys are supported; the earlier unpublished long-key format was removed. Sidebar width, collapse preference and offline storage mode are stored on the device. Offline storage never travels in a shared URL.
- On the first visit, choose **Download all maps** (recommended), **Current map only**, or **No offline storage**. The chooser and sidebar show compressed disk-size estimates for all maps and the current map, plus the smallest to largest map range when switching stations. The choice stays in localStorage, outside the URL. All-map mode saves metadata, search data and every sprite/zoom image in IndexedDB, including unopened maps. Current-map mode fully saves one station and removes the previous station when switching; outdated export revisions are removed too. No-storage mode bypasses and clears this app's IndexedDB map data (ordinary HTTP caching is browser-managed). Progress confirms when the download is saved. Reopening checks the small catalog and reuses saved resources. Unavailable/full storage is reported. The app shell remains ordinary static HTML/JavaScript.

The `o` bitmask uses these bit positions (a set bit enables the option):

| Bit | Option | Bit | Option |
| --- | --- | --- | --- |
| 0 | Atmospherics | 8 | Simple utility symbols |
| 1 | Power cables | 9 | Stair/ladder highlights |
| 2 | Waste disposal | 10 | Stair/ladder direction arrows |
| 3 | Transit tubes | 11 | Detailed tile inspector |
| 4 | Room boundaries | 12 | Placed items in search |
| 5 | Lower-deck visibility | 13 | Possible items in search |
| 6 | Animated parallax | 14 | Runtime terrain replacement |
| 7 | Separate power-network colors |  |  |

For example, bit 3 has value `8`; combining enabled options adds their values. A complete shared link might start with `#m=tramstation&z=2&x=3632&y=6160&s=1&o=29800`.

## Export another station or revision

Edit `atlas.config.json`. `ref` is an exact upstream Git commit, `maps` contains station JSON basenames from upstream `_maps/`, `chunkTiles` is the baked image grid size, and `tilePixels` is 32 for this game. Keep `tilePixels` at 32; the viewer's coordinate and aperture renderer uses BYOND's native 32-pixel tiles.

```powershell
pnpm source
pnpm export
pnpm test
pnpm build
```

The default `"maps": "all"` exports all upstream station configurations except the IDs in `excludeMaps`. Use an array of configuration basenames for a smaller catalog, or `pnpm export tramstation` for one map. `pnpm export --all` also respects exclusions. Exports are prepared in `.cache/` and published only after conversion succeeds. A failed conversion leaves the previous working export in place; discard leftover `.cache/export-*` folders when convenient. Run one exporter at a time. `pnpm build` rejects missing data and an export whose commit does not match the configured pin. It never downloads or converts the upstream source implicitly.

On Windows, preview file watchers can lock `public/data/` against a directory swap. In that case the exporter publishes an immutable snapshot inside `public/data/snapshots/` and atomically switches the root manifest to it. Existing views keep their old data until reloaded. The production build copies only the currently selected dataset, so old snapshots never inflate the deployed site. Failed conversions leave the previous manifest intact. A completed staging directory can also be published with `node scripts/promote.mjs .cache/export-<uuid>` without repeating conversion.

## GitHub Pages

1. Create a repository containing this project, including `pnpm-lock.yaml`, `atlas.config.json` and `.github/workflows/pages.yml`. Do not commit `.source/` or `public/data/`.
2. In repository **Settings → Pages**, select **GitHub Actions** as the source.
3. Push to `main`, or run **Build station atlas and deploy Pages** manually. Pull requests build and retain a review artifact without deploying.

The workflow resolves the latest upstream default-branch commit, pins that exact SHA for the run, installs the locked dependencies, downloads/caches that upstream checkout, runs parser tests, converts station data, builds `dist`, checks a conservative 950 MiB site budget, and deploys with the official Pages actions. It uses relative asset URLs, so repository paths such as `/station-atlas/` work without changing a base URL. Hash navigation needs no server rewrite rules. The workflow sets `VITE_ATLAS_SOURCE_URL` to the atlas repository so visitors can find the application source. Set that environment variable yourself for other hosting providers.

The workflow also checks upstream on the first of each month at **04:23 UTC**. It compares the upstream SHA with the public Pages map catalog and skips conversion/deployment when they match. An unavailable catalog causes a rebuild; failed exports leave the live site unchanged and will be retried on the next run. Pushes and manual runs always build, including atlas-only changes. Set optional `upstreamRef` in `atlas.config.json` to track a particular full branch ref instead of upstream HEAD. CI changes the pin only inside its runner; local conversion still uses the checked-in `ref`. Scheduled workflows must be enabled on the repository's default branch; GitHub may disable schedules in inactive public repositories after 60 days ([GitHub schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)).

The project repository is [scolastico/splurt-atlas](https://github.com/scolastico/splurt-atlas). Enable GitHub Pages in the repository settings when ready to deploy. Conversion runs in CI; GitHub Pages only serves the resulting files.

## Pipeline and output format

| Location | Purpose |
| --- | --- |
| `scripts/source.mjs` | Download or locally clone upstream and check out the exact configured commit |
| `scripts/lib/dmm.mjs` | Parse dictionaries, overrides, strings, nested lists, and coordinate blocks |
| `scripts/lib/dm.mjs` | Read declarations in `.dme` include order, inherit properties and static loot pools |
| `scripts/lib/appearance.mjs` | Expand declarative structure spawners and ordinary neighbor bitmask smoothing |
| `scripts/lib/dmi.mjs` | Read PNG DMI metadata; extract the first animation frame in the mapped direction |
| `scripts/export.mjs` | Bake sparse chunks at 512/256/128 px, overview images, transparency metadata, rooms and search records |
| `scripts/mipmaps.mjs` | Add zoom mipmaps to an existing export without re-rendering maps |
| `scripts/lib/infrastructure.mjs` | Derive cable components, connecting cable/pipe states, and deck destinations |
| `scripts/lib/door-access.mjs` | Resolve mapped door requirements against normal and expanded job ID access |
| `scripts/refresh-utilities.mjs` | Rebuild utility layers and derived door/network metadata on an existing export |
| `scripts/index-assets.mjs` | Write full offline asset inventories and assign a new cache build ID |
| `public/data/manifest.json` | Schema version, source repository/commit, station catalog and tile dimensions |
| `public/data/<map>/map.json` | Areas, room anchors, source paths, map traits, atom dictionaries, door roles and infrastructure graphs |
| `public/data/<map>/assets.json` | Relative paths and byte sizes for pre-caching the complete map |
| `public/data/<map>/<z>.json` | North-up row-major tile dictionary indices (`-1` for unmapped cells), sparse chunk index |
| `public/data/<map>/<z>/` | Lossless WebP chunks and mipmaps, small overview images and coarse PNG aperture mask |
| `public/data/<map>/search.json` | Item records, placed/possible classification, candidate spawner, and flat XYZ triples |
| `public/data/<map>/report.json` | Unresolved spawners and sprite fallback counts/samples |
| `public/data/asset-sources.json` | Referenced DMI paths and the exact source revision |

Map coordinates remain BYOND's one-based X/Y/Z; image Y coordinates are flipped so north is up. JSON dictionaries preserve original map object paths and overrides. A one-cell sprite gutter retains common pixel offsets and oversized sprites across chunk boundaries. Icons larger than the supported 96 × 96 tile composition, or offsets outside that gutter, are omitted. A failed conversion exits nonzero; rerun it before building updated data.

When the root manifest contains `dataPath`, the map paths in this table are relative to that snapshot directory. The production build flattens the selected snapshot back to `dist/data/` and omits `dataPath`.

## Performance

The viewer uses Canvas 2D and requests only visible image chunks. Resolution depends solely on zoom: below 12.5% it uses whole-station overviews, from 12.5% it uses 128 px chunks, from 25% it uses 256 px chunks, and from 50% it uses native 512 px chunks. Panning, station boundaries, enabled layers and visible chunk counts never change the selected resolution. Sprite pixels use nearest-neighbor rendering.

The decoded-image cache targets 128 MiB and protects visible images, overview fallbacks and the initial zoom neighborhood even if they exceed that target. The loading animation covers metadata/search preparation and decoding the current view plus nearby zoom levels, including the first zoom out. At most eight foreground image loads run concurrently. Whole layers switch to a new resolution only when their requested chunks are ready; cached coarser layers remain visible while loading, avoiding transparent gaps and per-image repaint flicker. Background offline downloads use four low-priority requests and yield while a selected station is being prepared. IndexedDB writes are batched with relaxed durability because these files are replaceable cache data.

Shared atom dictionaries reduce metadata repetition. Fuse.js search and index construction run in a worker with a 130 ms debounce; full coordinates are transferred only for the selected result. Finding lists render 30 rows per page. The station canvas updates on interaction, complete image batches and the short selection pulse. Continuous space motion uses a separate canvas capped at 30 paints per second. Device pixel ratio is capped at two. Encoded resources for all maps live on disk in IndexedDB; only the current station's images are decoded in memory.

These are architectural bounds, not a promise of a particular frame rate on every device. Several transparent decks and room-boundary labeling add work. Export time and memory depend on map complexity; the workflow allows 6 GiB of Node heap and a 60-minute build budget. Broadening the map catalog increases build time and Pages storage use.

## Accuracy and deliberate limits

This is a **static source atlas**, not a BYOND runtime emulator. It includes source maps and discoverable pre-round content. It does not execute Dream Maker, simulate a round, resolve arbitrary preprocessor conditionals, move shuttles into docking ports, generate ruins, or apply procedural map changes.

DM inheritance and simple constant properties are read in source include order. `MAP_SWITCH(runtime, editor)` selects the runtime appearance; simple `TRANSLATE_MATRIX(x,y)` offsets are applied to exported sprites, including oversized asteroid rocks. Ordinary bitmask smoothing uses declared smoothing groups; border-object smoothing, runtime filters, specialized diagonal underlays, lighting, overlays, game sprite animation, procedural icons and arbitrary `Initialize()` changes may differ from the game. Declarative structure `spawn_list` windows and grilles are expanded; procedural variations may remain approximate. Fallback icon states and missing images are counted in export reports. The exporter keeps map facts separately from the rendered approximation.

Possible spawn discovery follows literal `loot = list(...)` paths, nested static spawners and the declared maintenance/dumpster global pools. It does **not** evaluate probabilities, runtime predicates, dynamic subtype pickers, traits, procedural inventory, container population, circuit recipes, random seeds, or every custom spawner. Item locations inside dynamically populated containers are not exhaustive. No probability is claimed; inspect `unresolvedSpawners` for known gaps. Directly mapped random item subtypes may also replace themselves at initialization.

Power components and normal cable/smart-pipe connection sprites are reconstructed from static source rules. Runtime device changes, custom procedural connector rules, gas mixtures, capacity, pressure and actual power flow are not simulated. Stair chains and vertically paired ladders expose mapped destinations; special runtime teleport/ladder links may remain unresolved. Door roles reflect normal starting IDs, not access granted during a round, hacked doors, altered station policies or emergencies. Decks compose using baked sprite alpha, so opaque middle floors block deeper decks and transparent rock edges expose lower content. Glass/catwalk transparency uses known turf families; unusual runtime transparency overrides need explicit exporter rules. Coarse aperture masks remain as metadata. Shared DMM X/Y coordinates provide deck alignment.

## Validation

```powershell
pnpm test
pnpm build
node scripts/check-size.mjs
```

Tests cover DMM/TGM coordinates, nested overrides, comments, DMI frame offsets, network classification, cutaway turf rules, deterministic window expansion, wall smoothing, DM inheritance, `MAP_SWITCH` appearance macros, global loot pools, zoom thresholds, fuzzy search, grouped locations and URL state. `pnpm build` also validates exported grids and image references. For a visible browser smoke test, start `pnpm dev` in another terminal, install Chromium once with `pnpm exec playwright install chromium`, then run `node scripts/browser-smoke.mjs`. It checks sidebar collapse, fuzzy search and finding selection, full search/selection/camera URL restoration, deck switching, mobile layout, constant detail near map edges, background motion/pause, cache settling and pixel-level cutaway behavior. A regression check covers Tramstation Z2 tiles X114/Y63 (porous asteroid rock) and X114/Y62 (open space). Screenshots and a JSON report are saved under `.cache/qa/`. Set `ATLAS_URL` to test a production preview at a repository subpath.

`node scripts/features-smoke.mjs` checks the 16-map picker, resize grip, simple/detailed inspector, door roles, option-mask restoration and current-deck direction arrows. `node scripts/utility-smoke.mjs` compares utility-toggle pixels and verifies that the first zoom out needs no new image requests. `node scripts/terrain-smoke.mjs` checks natural terrain replacement, the original-marker toggle and door access and exclusion lists. `node scripts/cache-smoke.mjs` saves the full dataset in a fresh visible browser profile, restarts the browser, blocks map/sprite network requests and verifies previously unselected maps can still open. The full cold-cache check exercises roughly 452 MiB of resources; its profile and JSON evidence remain under `.cache/qa/` for review or reuse.

## License and attribution

The atlas application and scripts are **GNU AGPL v3 or later**; see [LICENSE](LICENSE). Game code, maps and sprites retain their upstream licenses and author credits. They are not relicensed by this project. Upstream documents CC BY-SA 3.0 for assets unless otherwise indicated, with individually marked exceptions including noncommercial assets. Consult [NOTICE](NOTICE), the bundled upstream README/license and the referenced file history before reuse. Exported files retain the upstream commit and icon-source inventory; the viewer links to source and asset credits.

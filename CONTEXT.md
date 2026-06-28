# Tree Graph — AI Context

## What This Is
A SvelteKit + SVG interactive 3-layer tree graph. No 3D library — pure SVG rendering with Svelte 5 runes.

## Stack
- **SvelteKit** (Svelte 5 runes: `$state`)
- **Pure SVG** for rendering (Threlte/Three.js was tried and removed)
- **TypeScript**
- **JetBrains Mono** via Google Fonts
- Single file: `src/routes/+page.svelte`

## Tree Structure
```
Node 1 → Node 2, Node 3
Node 2 → Node 4, Node 5
Node 3 → Node 6, Node 7
```
Node IDs: 0=Node1, 1=Node2, 2=Node3, 3=Node4, 4=Node5, 5=Node6, 6=Node7

## Features
- Starts focused on Node 1
- Click a node to focus it — centers, grows larger, related nodes visible in periphery
- Click focused node again to unfocus
- Font size encodes depth: left (root) = larger, right (leaves) = smaller
- Focused node gets biggest font; ancestors grow, descendants shrink by `FS_STEP` per depth level
- Layout scales `1.3×` on focus for a zoom-in feel
- Each edge rendered as a single L-shaped `<path>`: `M x1 y1 H midX V y2 H x2` — no shared segments, no overlap artifacts at corners
- Smooth lerp animation via `requestAnimationFrame`
- Focused node renders a dark highlight rect behind the label (sharp corners, `#111` fill)
- Light/warm theme (`#e8e8e3` background), muted greys, no color accents
- Active/inactive line coloring: connected-to-focus lines are `#555` 1.2px, others `#ccc` 0.6px

## Keyboard Navigation
- `h` — move to parent (left)
- `l` — move to first child (right)
- `j` — move to next node at same depth (down)
- `k` — move to previous node at same depth (up)
- `H/L` — jump to root / deepest descendant
- `J/K` — jump to bottom / top of current column
- `Space` — toggle bird's eye view (full tree) / zoomed view; returns to last focused node
- In bird's eye, `hjkl` updates selected node without zooming in — Space zooms into selection
- `?` — toggle help popup
- `Scroll` — scroll current column (j/k direction)

## Key Constants (tune these for visual feel)
```ts
FS_BASE  = 11   // default font size at depth 0
FS_STEP  = 4    // font size drop per depth level (default) / change per depth in focused mode
FS_FOCUS = 18   // font size of focused node
FS_MIN   = 5    // minimum font size
ROW_H    = 40   // vertical spacing between sibling nodes
COL_GAP  = 70   // horizontal spacing between depth columns
scale    = 1.3  // position spread multiplier when focused (in buildFocused)
SEG_DUR  = 22   // ms per intro line segment
CHAR_DUR = 12   // ms per character in typewriter intro effect
```

## Layout Algorithm
- **`buildDefault()`**: Reingold-Tilford style. Leaves get sequential Y slots. Parents centered between first/last child Y. Depth → X. Guarantees no edge crossings.
- **`buildFocused(fid)`**: Reuses `buildDefault` positions, shifts so focused node is at (0,0), scales positions by `1.3×`, assigns font size by depth delta from focused node.
- **`depthOf(id)`**: Returns tree depth of a node (0 = root).
- **`fsForDepth(depth)`**: Returns font size for a given absolute depth.
- **`getDistance(a, b)`**: BFS distance between any two nodes (traverses edges bidirectionally).

## Connector Rendering
**`buildConnectors()`** returns `EdgePath[]` — one per edge:
- Each edge is a single L-shaped path: `M x1 y1 H midX V y2 H x2`
- No shared segments between sibling edges — eliminates all T-joint overlap artifacts
- `active` flag: true if edge is connected to currently focused node
- `pathLength="1"` + `stroke-dashoffset` used for draw-in animation

No diagonals ever. Lines are axis-aligned in all states.

## Focus Highlight
Focused node renders a `<rect>` behind the `<text>`:
- Width: text width + `0.2×fs` padding each side
- Height: `1.1×fs`, shifted up `0.1×fs` to optically center against SVG text baseline
- Fill: `#111`, no border radius, opacity matches node opacity

## Intro Animation
Sequential left→right, top→bottom reveal:
1. **Lines**: `buildIntroSequence()` does a DFS walk assigning absolute ms timestamps. Each line segment (`SEG_DUR=22ms`) starts only after the previous finishes. Uses `stroke-dashoffset` with `pathLength="1"`.
2. **Text**: `buildNodeTextDelays()` assigns per-node text start times column by column (left→right), top→bottom within each column. Each node waits for the previous node in the same column to finish typing. Characters appear at `CHAR_DUR=12ms` each via `steps(1)` opacity snap on individual `<tspan>` elements.
- `introduced` state flips on mount via `requestAnimationFrame`, triggering all CSS animations simultaneously (delays handle sequencing).

## State
- `focusId` — currently focused node id (starts at `0`)
- `birdseye` — boolean, true when in bird's eye overview mode
- `introduced` — boolean, flips true on mount to trigger intro animations
- `showHelp` — boolean, toggles help overlay
- `target` — the layout positions being animated toward
- `anim` — current interpolated positions (reactive `$state`)

## Animation
`startAnim()` runs a `requestAnimationFrame` loop lerping `anim` toward `target` at `t=0.1` per frame. Stops when all nodes are within 1 unit of target.

`focusNode(id)` — updates `focusId` and animates (used by keyboard nav; does NOT toggle off).
`onClickNode(id)` — toggles focus off if clicking already-focused node; otherwise calls `focusNode`.

## Known Good State
- No line crossings in any focus state
- All nodes visible in periphery when focused
- No focus outline on click (suppressed via `outline: none`)
- Single `<path>` per edge — no overlap artifacts at line corners
- Bird's eye / zoom toggle works correctly with keyboard navigation
- Typewriter intro: left→right per node, top→bottom per column, one column at a time

## Possible Next Steps
- Add more nodes / deeper tree
- Add labels or metadata to nodes
- Make tree data dynamic/editable
- Add pan/zoom via pointer events
- Persist focus state in URL

# Tree Graph — AI Context

## What This Is
A SvelteKit + SVG interactive 3-layer tree graph. No 3D library — pure SVG rendering with Svelte 5 runes.

## Stack
- **SvelteKit** (Svelte 5 runes: `$state`)
- **Pure SVG** for rendering (Threlte/Three.js was tried and removed)
- **TypeScript**
- Single file: `src/routes/+page.svelte`

## Tree Structure
```
Node 1 → Node 2, Node 3
Node 2 → Node 4, Node 5
Node 3 → Node 6, Node 7
```
Node IDs: 0=Node1, 1=Node2, 2=Node3, 3=Node4, 4=Node5, 5=Node6, 6=Node7

## Features
- Click a node to focus it — it centers, grows larger, related nodes stay visible in periphery
- Click again to reset to default view
- Font size encodes depth: left (root) = larger, right (leaves) = smaller
- Focused node gets biggest font; ancestors grow, descendants shrink by `FS_STEP` per depth level
- Layout scales `1.3×` on focus for a zoom-in feel
- Unix `tree`-style connectors: shared vertical trunk per parent, horizontal branches to each child — no diagonal lines, no crossing lines
- Smooth lerp animation via `requestAnimationFrame`

## Key Constants (tune these for visual feel)
```ts
FS_BASE  = 11   // default font size at depth 0
FS_STEP  = 4    // font size drop per depth level
FS_FOCUS = 18   // font size of focused node
FS_MIN   = 5    // minimum font size
ROW_H    = 40   // vertical spacing between sibling nodes
COL_GAP  = 70   // horizontal spacing between depth columns
scale    = 1.3  // position spread multiplier when focused (in buildFocused)
```

## Layout Algorithm
- **`buildDefault()`**: Reingold-Tilford style. Leaves get sequential Y slots. Parents centered between first/last child Y. Depth → X. Guarantees no edge crossings.
- **`buildFocused(fid)`**: Reuses `buildDefault` positions, shifts so focused node is at (0,0), scales positions by `1.3×`, assigns font size by depth delta from focused node.
- **`depthOf(id)`**: Returns tree depth of a node (0 = root).
- **`fsForDepth(depth)`**: Returns font size for a given absolute depth.
- **`getDistance(a, b)`**: BFS distance between any two nodes (traverses edges bidirectionally).

## Connector Rendering
**`buildConnectors()`** returns `ConnectorGroup[]` — one per parent node:
- `hx1→hx2, hy`: horizontal line from parent right-edge to trunk X
- `trunkX, trunkY1, trunkY2`: vertical trunk spanning all children
- `branches[]`: horizontal line from trunk to each child's left-edge

This replaces the old per-edge elbow path approach. No diagonals ever.

## Animation
`startAnim()` runs a `requestAnimationFrame` loop lerping `anim` toward `target` at `t=0.1` per frame. Stops when all nodes are within 0.05 units of target.

## Known Good State
- No line crossings in any focus state
- All nodes visible in periphery when focused
- No focus outline on click (suppressed via `outline: none`)
- Unix tree connector lines stay axis-aligned regardless of zoom state

## Possible Next Steps
- Add more nodes / deeper tree
- Add labels or metadata to nodes
- Make tree data dynamic/editable
- Add pan/zoom via pointer events
- Persist focus state in URL

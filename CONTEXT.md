# Tree Graph — AI Context

## What This Is
A SvelteKit + SVG interactive tree graph backed by a real filesystem. No 3D library — pure SVG rendering with Svelte 5 runes. Each node corresponds to a directory under `content/`.

## Stack
- **SvelteKit** (Svelte 5 runes: `$state`, `$derived`, `tick`)
- **Pure SVG** for rendering
- **TypeScript**
- **JetBrains Mono** via Google Fonts
- Main UI: `src/routes/+page.svelte`
- API: `src/routes/api/nodes/+server.ts`

## Filesystem Structure
- `content/` is the root directory; its children are the top-level nodes
- `content/` itself is never emitted as a node — the API scans its children directly
- Node IDs are path-based: `node-1|node-2|node-4` (slashes replaced with `|`)
- Node paths are relative to `content/`: `/node-1/node-2/node-4`

## API (`/api/nodes`)
- `GET` — scans `content/` recursively, returns `{ nodes, edges }`. Root node (`content/`) is excluded.
- `POST { parentPath, name }` — creates a new subdirectory
- `PATCH { path, newName }` — renames a directory (in-place)
- `PATCH { action: 'move', path, newParentPath }` — moves a directory to a new parent
- `PUT { path, newParentPath, shallow? }` — copies a directory to a new parent; `shallow=true` creates empty dir (no children)
- `DELETE { path }` — removes a directory recursively

## API (`/api/undo`)
- `GET` — returns `{ canUndo, canRedo }`
- `POST { action: 'undo' }` — undoes last operation
- `POST { action: 'redo' }` — redoes last undone operation

## Undo/Redo Architecture
- Server-side in-memory action log in `src/routes/api/history.ts`
- `undoStack` / `redoStack` — arrays of `UndoAction` (module-level singletons, persist across requests in dev)
- Each mutating API call pushes to `undoStack` via `pushUndo()` and clears `redoStack`
- `UndoAction` types: `create`, `delete`, `rename`, `move`, `copy`
- `delete` actions snapshot the directory to `.tree-snapshots/` before deletion so it can be restored
- `applyUndo(action)` inverts the action and returns the inverse action (pushed to `redoStack` on undo, back to `undoStack` on redo)
- `u` key calls `POST /api/undo { action: 'undo' }` then reloads tree
- `Ctrl+r` calls `POST /api/undo { action: 'redo' }` then reloads tree

## Features
- Starts focused on root node
- Click a node to focus it — centers, grows larger, related nodes visible in periphery
- Click focused node again to unfocus
- Font size encodes depth: left (root) = larger, right (leaves) = smaller
- Focused node gets biggest font; ancestors/descendants scale by `FS_STEP` per depth level
- Layout scales `1.3×` on focus for a zoom-in feel
- Smooth lerp animation via `requestAnimationFrame`
- Focused node renders a dark highlight rect behind the label (`#111` fill, sharp corners)
- Light/warm theme (`#e8e8e3` background), muted greys, no color accents
- Active/inactive line coloring: connected-to-focus lines are `#555` 1.2px, others `#ccc` 0.6px

## Keyboard Navigation
- `h` — move to parent (left)
- `l` — move to first child (right)
- `j` — move to next node at same depth (down)
- `k` — move to previous node at same depth (up)
- `H/L` — jump to root / deepest descendant
- `J/K` — jump to bottom / top of current column
- `Tab` — collapse / expand focused node (hides subtree; shows `▸N` badge with child count)
- `o` — create sibling node (same column) with inline rename prompt
- `O` — create child node (next column) with inline rename prompt
- `y` — yank node only (no children); `Y` — yank with full subtree
- `m` — mark focused node for move
- `p` — paste/move as sibling of focused node (under focused node's parent); `P` — paste/move as child of focused node
- `u` — undo last operation; `Ctrl+r` — redo
- Escape cancels active yank/move mode
- `x` — delete focused node (prompts confirmation; Enter to confirm, Escape to cancel)
- `Space` — toggle bird's eye view (full tree) / zoomed view
- In bird's eye, `hjkl` updates selected node without zooming in — Space zooms into selection
- `/` — open fuzzy search overlay
- `:` — open vim-style command bar
- `?` — toggle help popup
- `Scroll` — scroll current column (j/k direction)

## Key Constants (tune these for visual feel)
```ts
FS_BASE  = 11   // default font size at depth 0
FS_STEP  = 4    // font size drop per depth level (default) / change per depth in focused mode
FS_FOCUS = 18   // font size of focused node
FS_MIN   = 5    // minimum font size
ROW_H    = 40   // vertical spacing between sibling nodes (default view)
COL_GAP  = 70   // horizontal spacing between depth columns
scale    = 1.3  // position spread multiplier when focused (in buildFocused)
SEG_DUR  = 22   // ms per intro line segment
CHAR_DUR = 12   // ms per character in typewriter intro effect
```
Bird's eye view uses tighter spacing: `rowH=24, colGap=45`.

## Layout Algorithm
- **`buildDefault(rowH, colGap)`**: Equal-slot subtree algorithm. `subtreeH(id)` computes the vertical span a subtree needs (max child subtreeH × child count). Each child gets an equal slot = max sibling subtreeH. This guarantees parent Y always equals the trunk midpoint (no off-center connectors). Depth → X.
- **`buildFocused(fid)`**: Reuses `buildDefault` positions, shifts so focused node is at (0,0), scales by `1.3×`, assigns font size by depth delta from focused node.
- **`depthOf(id)`**: Returns tree depth of a node (0 = root).
- **`fsForDepth(depth)`**: Returns font size for a given absolute depth.

## Connector Rendering
**`buildConnectors()`** returns `Connector[]` — trunk + branch per parent:
- **Trunk**: one path per parent node. `M px1 p.y H mx V trunkY1 M mx p.y V trunkY2` — H line from parent to trunk X, then vertical spans up and down to first/last child Y.
- **Branch**: one `M mx c.y H cx2` per child — horizontal from trunk to child label edge.
- `active` flag: true if edge is connected to currently focused node
- `pathLength="1"` + `stroke-dashoffset` used for draw-in animation

No diagonals ever. Lines are axis-aligned in all states.

## Node Creation
- `o` key calls `createSiblingNode()`, `O` key calls `createChildNode()`
- Generates a unique temp name (`new-node`, `new-node-1`, etc.) to avoid 409 conflicts
- Creates the directory via POST, then `loadTree()` + `tick()` to flush DOM, then shows inline rename
- `renamingIsNew = true` flag distinguishes new-node rename from regular rename
- Inline rename: `<foreignObject>` sized dynamically to fit current input value
- Enter with unchanged name → keeps directory as-is (no rename API call)
- Enter with new name → renames directory via PATCH
- Escape → deletes the temp directory via DELETE and refocuses parent

## Inline Rename State
```ts
let renamingId    = $state<string | null>(null);
let renameValue   = $state('');
let renamingIsNew = $state(false);
```
- `startRename(id, label, isNew?)` — sets all three
- `commitRename()` — renames if name changed; if `renamingIsNew` and name unchanged, just closes (keeps node)
- `cancelRename()` — closes; if `renamingIsNew`, deletes directory and refocuses parent

## Delete Node
- `x` key sets `confirmDeleteId` to show confirmation dialog
- Enter in `onKeyNav` while `confirmDeleteId` is set confirms deletion
- Escape cancels; clicking Cancel button cancels
- Deletes directory recursively via DELETE API, reloads tree, focuses parent

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
- `focusId` — currently focused node id
- `birdseye` — boolean, true when in bird's eye overview mode
- `introduced` — boolean, flips true on mount to trigger intro animations
- `showHelp` — boolean, toggles help overlay
- `confirmDeleteId` — node id pending delete confirmation, or null
- `collapsed` — `Set<string>` of node ids whose children are hidden; `visibleNodes`/`visibleEdges` are `$derived` filtered views used by all layout/render functions
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
- Trunk connector H line always meets trunk at exact visual center between children (equal-slot layout guarantees this)
- Bird's eye / zoom toggle works correctly with keyboard navigation
- Typewriter intro: left→right per node, top→bottom per column, one column at a time
- Rofi-style fuzzy search: `/` key or clicking "/ search" in hint bar opens dark overlay; type to filter, `↑/↓`/`Tab` to select, `Enter` to jump, `Escape` or click outside to close
- Node creation: `o`/`O` keys create nodes with unique temp names, inline rename prompt, Escape cancels and deletes temp dir
- Delete: `x` key with confirmation dialog, Enter to confirm, Escape to cancel

## Fuzzy Search
- `showSearch` state toggles overlay
- `searchQuery` bound to input, `searchSel` tracks highlighted result index
- `fuzzyMatch(query, label)`: character subsequence match (not substring)
- `searchResults()`: filters nodes by fuzzyMatch
- `openSearch()` / `closeSearch()` / `commitSearch()`: open, dismiss, and navigate
- `onSearchKey()`: handles `Escape`, `Enter`, `ArrowUp/Down`, `Tab` inside the input
- `onKeyNav` passes `Escape` through when search is open; blocks all other nav keys while search is active
- Clicking overlay backdrop closes; clicking inside search box stops propagation
- `focusOnMount` action: Svelte action that focuses the input element on mount

## Command Bar
- `:` key opens vim-style command bar at bottom of screen
- `CMD_REGISTRY`: array of `{ name, desc }` objects — single source of truth for all commands
- `cmdSuggestions()`: fuzzy-filters registry against both name and description using `fuzzyMatch`
- Suggestions list renders above the input row, updates live as you type
- `↑/↓` arrows move selection, `Tab` completes selected command into input
- `Enter` runs the highlighted suggestion if it differs from typed input (works with partial typing); otherwise runs typed command directly
- Clicking a suggestion runs it directly
- `Escape` closes; errors shown inline in red
- `cmdSel` resets to 0 on every input change

### Available Commands
| Command | Action |
|---|---|
| `help` | Open keyboard shortcuts popup |
| `bird` / `birdseye` | Switch to bird's eye view |
| `zoom` | Zoom into focused node |
| `root` | Focus root node |
| `search` | Open fuzzy search |
| `focus <name>` | Focus node by exact name |
| `q` / `quit` | Close command bar |

## Possible Next Steps
- Add labels or metadata to nodes
- Add pan/zoom via pointer events
- Persist focus state in URL
- Support moving nodes (drag or cut/paste)

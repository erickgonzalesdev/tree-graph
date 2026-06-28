<script lang="ts">
	import { onMount } from 'svelte';

	// --- Data ---

	const nodes = [
		{ id: 0, label: 'Node 1' },
		{ id: 1, label: 'Node 2' },
		{ id: 2, label: 'Node 3' },
		{ id: 3, label: 'Node 4' },
		{ id: 4, label: 'Node 5' },
		{ id: 5, label: 'Node 6' },
		{ id: 6, label: 'Node 7' }
	];

	const edges: [number, number][] = [
		[0, 1], [0, 2],
		[1, 3], [1, 4],
		[2, 5], [2, 6]
	];

	function getChildren(id: number) {
		return edges.filter(([a]) => a === id).map(([, b]) => b);
	}
	function getParents(id: number) {
		return edges.filter(([, b]) => b === id).map(([a]) => a);
	}

	// --- Constants ---

	const CHAR_W   = 0.6;
	const FS_BASE  = 11;
	const FS_STEP  = 4;
	const FS_FOCUS = 18;
	const FS_MIN   = 5;
	const ROW_H    = 40;
	const COL_GAP  = 70;
	const SEG_DUR  = 22;
	const CHAR_DUR = 12;

	const CMD_REGISTRY = [
		{ name: 'help',   desc: "open keyboard shortcuts" },
		{ name: 'bird',   desc: "switch to bird's eye view" },
		{ name: 'zoom',   desc: "zoom into focused node" },
		{ name: 'root',   desc: "focus root node" },
		{ name: 'search', desc: "open fuzzy search" },
		{ name: 'focus',  desc: "focus <node name>" },
		{ name: 'q',      desc: "close command bar" },
	];

	// --- Types ---

	type NodePos = { x: number; y: number; fs: number; opacity: number };

	// --- Layout helpers ---

	function tw(label: string, fs: number) {
		return label.length * CHAR_W * fs;
	}

	function depthOf(id: number): number {
		const parents = getParents(id);
		return parents.length === 0 ? 0 : 1 + depthOf(parents[0]);
	}

	function fsForDepth(depth: number): number {
		return Math.max(FS_MIN, FS_BASE - depth * FS_STEP);
	}

	function buildDefault(): Record<number, NodePos> {
		const COL_W = tw('Node X', FS_BASE) + COL_GAP;
		const result: Record<number, NodePos> = {};

		let leafIndex = 0;
		const leafSlot: Record<number, number> = {};
		function assignLeaves(id: number) {
			const ch = getChildren(id);
			if (ch.length === 0) leafSlot[id] = leafIndex++;
			else ch.forEach(c => assignLeaves(c));
		}
		assignLeaves(0);

		function getY(id: number): number {
			const ch = getChildren(id);
			if (ch.length === 0) return leafSlot[id] * ROW_H;
			const ys = ch.map(c => getY(c));
			return (ys[0] + ys[ys.length - 1]) / 2;
		}

		function place(id: number, depth: number) {
			result[id] = { x: depth * COL_W, y: getY(id), fs: fsForDepth(depth), opacity: 1 };
			getChildren(id).forEach(c => place(c, depth + 1));
		}
		place(0, 0);

		const xs = Object.values(result).map(p => p.x);
		const ys = Object.values(result).map(p => p.y);
		const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
		const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
		Object.values(result).forEach(p => { p.x -= cx; p.y -= cy; });
		return result;
	}

	function buildFocused(fid: number): Record<number, NodePos> {
		const base = buildDefault();
		const fx = base[fid].x;
		const fy = base[fid].y;
		const focusDepth = depthOf(fid);
		const scale = 1.3;
		const result: Record<number, NodePos> = {};
		nodes.forEach(n => {
			const depthDelta = depthOf(n.id) - focusDepth;
			const absDelta = Math.abs(depthDelta);
			result[n.id] = {
				x: (base[n.id].x - fx) * scale,
				y: (base[n.id].y - fy) * scale,
				fs: Math.max(FS_MIN, FS_FOCUS - depthDelta * FS_STEP),
				opacity: absDelta === 0 ? 1 : absDelta === 1 ? 0.85 : absDelta === 2 ? 0.55 : 0.3
			};
		});
		return result;
	}

	// Returns node IDs at a given depth, sorted top-to-bottom
	function colAt(depth: number): number[] {
		const base = buildDefault();
		return nodes
			.filter(n => depthOf(n.id) === depth)
			.sort((a, b) => base[a.id].y - base[b.id].y)
			.map(n => n.id);
	}

	// --- Intro animation ---

	function buildIntroSequence(): Record<string, number> {
		const delays: Record<string, number> = {};
		let t = 0;
		function walk(pid: number) {
			const children = getChildren(pid);
			if (children.length === 0) return;
			delays[`h-${pid}`] = t; t += SEG_DUR;
			delays[`trunk-${pid}`] = t; t += SEG_DUR;
			children.forEach((cid, bi) => {
				delays[`b-${pid}-${bi}`] = t; t += SEG_DUR;
				walk(cid);
			});
		}
		walk(0);
		return delays;
	}

	function buildNodeTextDelays(): Record<number, number> {
		const base = buildDefault();
		const maxDepth = Math.max(...nodes.map(n => depthOf(n.id)));
		const delays: Record<number, number> = {};
		let colStart = 0;
		for (let depth = 0; depth <= maxDepth; depth++) {
			const col = nodes
				.filter(n => depthOf(n.id) === depth)
				.sort((a, b) => base[a.id].y - base[b.id].y);
			let t = colStart;
			for (const n of col) {
				delays[n.id] = t;
				t += n.label.length * CHAR_DUR;
			}
			colStart = t;
		}
		return delays;
	}

	const introSeq = buildIntroSequence();
	const nodeTextDelays = buildNodeTextDelays();

	// --- Animation ---

	function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

	let target: Record<number, NodePos> = buildFocused(0);
	let anim: Record<number, NodePos> = $state(
		nodes.reduce((acc, n) => { acc[n.id] = { ...target[n.id] }; return acc; }, {} as Record<number, NodePos>)
	);
	let rafId = 0;

	function startAnim() {
		cancelAnimationFrame(rafId);
		const step = () => {
			let moving = false;
			const next: Record<number, NodePos> = {};
			nodes.forEach(n => {
				const a = anim[n.id];
				const t = target[n.id];
				const nx = lerp(a.x, t.x, 0.1);
				const ny = lerp(a.y, t.y, 0.1);
				next[n.id] = { x: nx, y: ny, fs: lerp(a.fs, t.fs, 0.1), opacity: lerp(a.opacity, t.opacity, 0.1) };
				if (Math.abs(nx - t.x) > 1 || Math.abs(ny - t.y) > 1) moving = true;
			});
			anim = next;
			if (moving) rafId = requestAnimationFrame(step);
		};
		rafId = requestAnimationFrame(step);
	}

	// --- State ---

	let focusId  = $state<number | null>(0);
	let birdseye = $state(false);
	let showHelp = $state(false);
	let showSearch  = $state(false);
	let searchQuery = $state('');
	let searchSel   = $state(0);
	let showCmd  = $state(false);
	let cmdInput = $state('');
	let cmdError = $state('');
	let cmdSel   = $state(0);
	let introduced = $state(false);

	onMount(() => { requestAnimationFrame(() => { introduced = true; }); });

	function focusOnMount(el: HTMLElement) { setTimeout(() => el.focus(), 0); }

	// --- Navigation ---

	function focusNode(id: number) {
		focusId = id;
		if (!birdseye) { target = buildFocused(id); startAnim(); }
	}

	function onClickNode(id: number) {
		birdseye = false;
		if (focusId === id) {
			focusId = null;
			target = buildDefault();
		} else {
			focusNode(id);
		}
		startAnim();
	}

	function onKeyNav(e: KeyboardEvent) {
		if (showCmd)    { if (e.key === 'Escape') closeCmd();    return; }
		if (showSearch) { if (e.key === 'Escape') closeSearch(); return; }

		if (e.key === ':') { e.preventDefault(); openCmd();    return; }
		if (e.key === '/') { e.preventDefault(); openSearch(); return; }
		if (e.key === '?') { showHelp = !showHelp; return; }
		if (e.key === 'Escape') { showHelp = false; return; }

		if (e.key === ' ') {
			e.preventDefault();
			birdseye = !birdseye;
			target = birdseye ? buildDefault() : buildFocused(focusId ?? 0);
			startAnim();
			return;
		}

		if (!['h','j','k','l','H','J','K','L'].includes(e.key)) return;
		e.preventDefault();

		const from = focusId ?? 0;
		const col = colAt(depthOf(from));
		const idx = col.indexOf(from);
		let next: number | null = null;

		switch (e.key) {
			case 'l': { const ch = getChildren(from); if (ch.length) next = ch[0]; break; }
			case 'L': { let n = from; while (getChildren(n).length) n = getChildren(n)[0]; if (n !== from) next = n; break; }
			case 'h': { const par = getParents(from); if (par.length) next = par[0]; break; }
			case 'H': { let n = from; while (getParents(n).length) n = getParents(n)[0]; if (n !== from) next = n; break; }
			case 'j': if (idx < col.length - 1) next = col[idx + 1]; break;
			case 'J': next = col[col.length - 1]; break;
			case 'k': if (idx > 0) next = col[idx - 1]; break;
			case 'K': next = col[0]; break;
		}

		if (next !== null && next !== from) focusNode(next);
	}

	let wheelAccum = 0;
	function onWheel(e: WheelEvent) {
		e.preventDefault();
		wheelAccum += e.deltaY;
		if (Math.abs(wheelAccum) < 60) return;
		const dir = wheelAccum > 0 ? 1 : -1;
		wheelAccum = 0;
		const from = focusId ?? 0;
		const col = colAt(depthOf(from));
		const idx = col.indexOf(from);
		const next = col[idx + dir];
		if (next !== undefined) focusNode(next);
	}

	// --- Search ---

	function fuzzyMatch(query: string, str: string): boolean {
		if (!query) return true;
		const q = query.toLowerCase();
		const s = str.toLowerCase();
		let qi = 0;
		for (let i = 0; i < s.length && qi < q.length; i++) {
			if (s[i] === q[qi]) qi++;
		}
		return qi === q.length;
	}

	function searchResults() { return nodes.filter(n => fuzzyMatch(searchQuery, n.label)); }

	function openSearch()  { showSearch = true;  searchQuery = ''; searchSel = 0; }
	function closeSearch() { showSearch = false; searchQuery = ''; searchSel = 0; }

	function commitSearch() {
		const results = searchResults();
		if (results[searchSel]) { birdseye = false; focusNode(results[searchSel].id); }
		closeSearch();
	}

	function onSearchKey(e: KeyboardEvent) {
		if (e.key === 'Escape')                          { e.preventDefault(); closeSearch(); return; }
		if (e.key === 'Enter')                           { e.preventDefault(); commitSearch(); return; }
		if (e.key === 'ArrowDown' || e.key === 'Tab')    { e.preventDefault(); searchSel = Math.min(searchSel + 1, searchResults().length - 1); return; }
		if (e.key === 'ArrowUp')                         { e.preventDefault(); searchSel = Math.max(searchSel - 1, 0); return; }
	}

	// --- Command bar ---

	function cmdSuggestions() {
		const q = cmdInput.trim().toLowerCase();
		return q ? CMD_REGISTRY.filter(c => fuzzyMatch(q, c.name) || fuzzyMatch(q, c.desc)) : CMD_REGISTRY;
	}

	function openCmd()  { showCmd = true;  cmdInput = ''; cmdError = ''; cmdSel = 0; }
	function closeCmd() { showCmd = false; cmdInput = ''; cmdError = ''; cmdSel = 0; }

	function runCmd(raw: string) {
		const parts = raw.trim().split(/\s+/);
		const cmd  = parts[0].toLowerCase();
		const args = parts.slice(1).join(' ');
		switch (cmd) {
			case 'q': case 'quit':
				closeCmd(); return;
			case 'help':
				closeCmd(); showHelp = true; return;
			case 'bird': case 'birdeye': case 'birdseye':
				closeCmd(); birdseye = true; target = buildDefault(); startAnim(); return;
			case 'zoom':
				closeCmd(); birdseye = false; target = buildFocused(focusId ?? 0); startAnim(); return;
			case 'root':
				closeCmd(); birdseye = false; focusNode(0); return;
			case 'search':
				closeCmd(); openSearch(); return;
			case 'focus': {
				if (!args) { cmdError = 'usage: focus <node name>'; return; }
				const match = nodes.find(n => n.label.toLowerCase() === args.toLowerCase());
				if (!match) { cmdError = `no node: "${args}"`; return; }
				closeCmd(); birdseye = false; focusNode(match.id); return;
			}
			default:
				cmdError = `unknown command: "${cmd}"`;
		}
	}

	function onCmdKey(e: KeyboardEvent) {
		const sugg = cmdSuggestions();
		if (e.key === 'Escape') { e.preventDefault(); closeCmd(); return; }
		if (e.key === 'Enter') {
			e.preventDefault();
			if (sugg[cmdSel] && sugg[cmdSel].name !== cmdInput.trim()) {
				const s = sugg[cmdSel];
				cmdInput = s.name === 'focus' ? 'focus ' : s.name;
				if (s.name !== 'focus') { runCmd(cmdInput); return; }
			} else {
				runCmd(cmdInput);
			}
			return;
		}
		if (e.key === 'Tab')       { e.preventDefault(); if (sugg.length) { const s = sugg[cmdSel]; cmdInput = s.name === 'focus' ? 'focus ' : s.name; cmdSel = 0; } return; }
		if (e.key === 'ArrowUp')   { e.preventDefault(); cmdSel = Math.max(0, cmdSel - 1); return; }
		if (e.key === 'ArrowDown') { e.preventDefault(); cmdSel = Math.min(cmdSel + 1, sugg.length - 1); return; }
		cmdError = '';
		cmdSel = 0;
	}

	// --- Connectors ---

	type EdgePath = { parentId: number; childId: number; d: string; opacity: number; active: boolean };

	function isConnectedToFocus(pid: number): boolean {
		if (focusId === null) return true;
		const ch = getChildren(pid);
		return pid === focusId
			|| ch.includes(focusId)
			|| getParents(focusId).includes(pid)
			|| ch.some(c => getParents(focusId).includes(c))
			|| getParents(pid).some(p => p === focusId);
	}

	function buildConnectors(): EdgePath[] {
		return edges.map(([pid, cid]) => {
			const p = anim[pid], c = anim[cid];
			const x1 = p.x + tw(nodes[pid].label, p.fs) / 2;
			const x2 = c.x - tw(nodes[cid].label, c.fs) / 2;
			const midX = (x1 + x2) / 2;
			return {
				parentId: pid, childId: cid,
				d: `M ${x1} ${p.y} H ${midX} V ${c.y} H ${x2}`,
				opacity: Math.min(p.opacity, c.opacity) * 0.85,
				active: isConnectedToFocus(pid)
			};
		});
	}
</script>

<svelte:head>
	<title>Tree Graph</title>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet" />
</svelte:head>

<svelte:window onkeydown={onKeyNav} />

<div class="scene" onwheel={onWheel}>
	<svg width="100%" height="100%" viewBox="-380 -220 760 440" preserveAspectRatio="xMidYMid meet">
		<g>
			{#each buildConnectors() as ep (`${ep.parentId}-${ep.childId}`)}
				{@const bi = getChildren(ep.parentId).indexOf(ep.childId)}
				<path
					class="connector"
					class:introduced
					d={ep.d}
					fill="none"
					stroke={ep.active ? '#555' : '#ccc'}
					stroke-width={ep.active ? 1.2 : 0.6}
					opacity={ep.opacity}
					pathLength="1"
					style="transition: stroke 0.3s, stroke-width 0.3s; animation-delay: {introSeq[`b-${ep.parentId}-${bi}`]}ms"
				/>
			{/each}

			{#each nodes as node}
				{@const p = anim[node.id]}
				{#if focusId === node.id}
					{@const pad = p.fs * 0.2}
					{@const w = tw(node.label, p.fs) + pad * 2}
					<rect
						x={p.x - w / 2}
						y={p.y - p.fs * 1.1 / 2 - p.fs * 0.1}
						width={w}
						height={p.fs * 1.1}
						fill="#111"
						opacity={p.opacity}
					/>
				{/if}
				<text
					class="node-label"
					class:focused={focusId === node.id}
					x={p.x} y={p.y}
					text-anchor="middle"
					dominant-baseline="middle"
					font-size={p.fs}
					opacity={p.opacity}
					onclick={() => onClickNode(node.id)}
					role="button"
					tabindex="0"
					onkeydown={(e) => e.key === 'Enter' && onClickNode(node.id)}
				>{#each node.label.split('') as char, ci}<tspan
						class="char"
						class:introduced
						style="animation-delay: {nodeTextDelays[node.id] + ci * CHAR_DUR}ms"
					>{char}</tspan>{/each}</text>
			{/each}
		</g>
	</svg>

	<div class="hint">
		{#if birdseye}
			Space to zoom back in
		{:else}
			hjkl navigate · <span class="hint-btn" onclick={openSearch}>/ search</span> · Space birds eye · ? help
		{/if}
	</div>

	{#if showSearch}
		<div class="search-overlay" role="dialog" aria-modal="true" onclick={closeSearch}>
			<div class="search-box" onclick={(e) => e.stopPropagation()}>
				<div class="search-input-row">
					<span class="search-slash">/</span>
					<input
						bind:value={searchQuery}
						class="search-input"
						placeholder="search nodes..."
						autocomplete="off"
						spellcheck={false}
						onkeydown={onSearchKey}
						oninput={() => { searchSel = 0; }}
						use:focusOnMount
					/>
				</div>
				<ul class="search-results">
					{#each searchResults() as node, i}
						<li
							class="search-result"
							class:selected={i === searchSel}
							onclick={() => { searchSel = i; commitSearch(); }}
							onmouseenter={() => { searchSel = i; }}
							role="option"
							aria-selected={i === searchSel}
						>{node.label}</li>
					{/each}
					{#if searchResults().length === 0}
						<li class="search-empty">no results</li>
					{/if}
				</ul>
			</div>
		</div>
	{/if}

	{#if showCmd}
		<div class="cmd-bar">
			{#if cmdSuggestions().length > 0}
				<ul class="cmd-suggestions">
					{#each cmdSuggestions() as s, i}
						<li
							class="cmd-suggestion"
							class:selected={i === cmdSel}
							onclick={() => { cmdInput = s.name === 'focus' ? 'focus ' : s.name; if (s.name !== 'focus') runCmd(cmdInput); }}
							onmouseenter={() => { cmdSel = i; }}
						><span class="cmd-sname">{s.name}</span><span class="cmd-sdesc">{s.desc}</span></li>
					{/each}
				</ul>
			{/if}
			<div class="cmd-input-row">
				<span class="cmd-colon">:</span>
				<input
					class="cmd-input"
					bind:value={cmdInput}
					autocomplete="off"
					spellcheck={false}
					onkeydown={onCmdKey}
					oninput={() => { cmdSel = 0; cmdError = ''; }}
					use:focusOnMount
				/>
				{#if cmdError}<span class="cmd-error">{cmdError}</span>{/if}
			</div>
		</div>
	{/if}

	{#if showHelp}
		<div class="help-overlay" onclick={() => showHelp = false} role="dialog" aria-modal="true">
			<div class="help-box" onclick={(e) => e.stopPropagation()}>
				<div class="help-title">Keyboard Shortcuts</div>
				<table>
					<tbody>
						<tr><td>h / l</td><td>Move to parent / first child</td></tr>
						<tr><td>j / k</td><td>Move down / up in column</td></tr>
						<tr><td>H / L</td><td>Jump to root / deepest child</td></tr>
						<tr><td>J / K</td><td>Jump to bottom / top of column</td></tr>
						<tr><td>Space</td><td>Toggle bird's eye view</td></tr>
						<tr><td>Scroll</td><td>Scroll current column</td></tr>
						<tr><td>/</td><td>Fuzzy search nodes</td></tr>
						<tr><td>:</td><td>Command bar</td></tr>
						<tr><td>?</td><td>Toggle this help</td></tr>
						<tr><td>Esc</td><td>Close help</td></tr>
					</tbody>
				</table>
			</div>
		</div>
	{/if}
</div>

<style>
	:global(body, html) {
		margin: 0; padding: 0;
		width: 100%; height: 100%;
		overflow: hidden;
		background: #e8e8e3;
	}

	.scene { width: 100vw; height: 100vh; position: relative; }

	@keyframes pop-in  { from { opacity: 0; } to { opacity: 1; } }
	@keyframes draw-in { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }

	.char { opacity: 0; }
	.char.introduced { animation: pop-in 0.05s steps(1) both; }

	.connector { stroke-linecap: butt; stroke-linejoin: miter; }
	.connector:not(.introduced) { stroke-dasharray: 1; stroke-dashoffset: 1; opacity: 0; }
	.connector.introduced { stroke-dasharray: 1; animation: draw-in 0.022s linear both; }

	.node-label {
		font-family: 'JetBrains Mono', monospace;
		font-weight: 600;
		fill: #3a3a3a;
		cursor: pointer;
		user-select: none;
		outline: none;
	}
	.node-label:hover  { fill: #222; }
	.node-label.focused { fill: #f0f0eb; font-weight: 800; }

	.hint {
		position: absolute;
		top: 1rem; left: 50%;
		transform: translateX(-50%);
		color: #888;
		font-family: 'JetBrains Mono', monospace;
		font-size: 0.75rem;
		background: rgba(232, 232, 227, 0.85);
		padding: 0.4rem 1rem;
		border-radius: 999px;
		pointer-events: none;
		backdrop-filter: blur(4px);
	}
	.hint-btn { pointer-events: all; cursor: pointer; color: #555; }
	.hint-btn:hover { color: #222; }

	.help-overlay {
		position: fixed; inset: 0;
		background: rgba(0,0,0,0.25);
		display: flex; align-items: center; justify-content: center;
		z-index: 10;
	}
	.help-box {
		background: #e8e8e3;
		border: 1px solid #ccc;
		padding: 1.5rem 2rem;
		font-family: 'JetBrains Mono', monospace;
		font-size: 0.8rem;
		color: #3a3a3a;
		min-width: 18rem;
	}
	.help-title { font-weight: 800; font-size: 0.9rem; margin-bottom: 1rem; color: #111; }
	.help-box table { border-collapse: collapse; width: 100%; }
	.help-box td { padding: 0.25rem 0.5rem; }
	.help-box td:first-child { font-weight: 700; color: #111; white-space: nowrap; }
	.help-box tr:hover td { background: rgba(0,0,0,0.05); }

	.search-overlay {
		position: fixed; inset: 0;
		display: flex; align-items: flex-start; justify-content: center;
		padding-top: 15vh;
		z-index: 20;
		background: rgba(0,0,0,0.45);
	}
	.search-box {
		width: 360px;
		background: #1a1a1a;
		border: 1px solid #444;
		font-family: 'JetBrains Mono', monospace;
	}
	.search-input-row {
		display: flex; align-items: center;
		border-bottom: 1px solid #333;
		padding: 0 0.75rem;
	}
	.search-slash { color: #666; font-size: 0.9rem; margin-right: 0.5rem; user-select: none; }
	.search-input {
		flex: 1; background: transparent; border: none; outline: none;
		color: #e8e8e3; font-family: 'JetBrains Mono', monospace;
		font-size: 0.85rem; padding: 0.6rem 0; caret-color: #e8e8e3;
	}
	.search-input::placeholder { color: #555; }
	.search-results { list-style: none; margin: 0; padding: 0.25rem 0; max-height: 240px; overflow-y: auto; }
	.search-result  { padding: 0.4rem 1rem; color: #aaa; font-size: 0.82rem; cursor: pointer; }
	.search-result.selected { background: #2e2e2e; color: #e8e8e3; }
	.search-empty   { padding: 0.4rem 1rem; color: #555; font-size: 0.82rem; font-style: italic; }

	.cmd-bar {
		position: fixed; bottom: 0; left: 0; right: 0;
		background: #1a1a1a; border-top: 1px solid #444;
		z-index: 20; font-family: 'JetBrains Mono', monospace;
	}
	.cmd-suggestions { list-style: none; margin: 0; padding: 0.25rem 0; border-bottom: 1px solid #333; }
	.cmd-suggestion  { display: flex; gap: 1rem; padding: 0.3rem 0.75rem; cursor: pointer; color: #888; font-size: 0.8rem; }
	.cmd-suggestion.selected { background: #2e2e2e; color: #e8e8e3; }
	.cmd-sname { min-width: 5rem; font-weight: 600; }
	.cmd-sdesc { color: #555; font-size: 0.78rem; }
	.cmd-suggestion.selected .cmd-sdesc { color: #aaa; }
	.cmd-input-row { display: flex; align-items: center; padding: 0.35rem 0.75rem; gap: 0.1rem; }
	.cmd-colon { color: #e8e8e3; font-size: 0.85rem; user-select: none; }
	.cmd-input {
		flex: 1; background: transparent; border: none; outline: none;
		color: #e8e8e3; font-family: 'JetBrains Mono', monospace;
		font-size: 0.85rem; caret-color: #e8e8e3; padding: 0;
	}
	.cmd-error { color: #e06c75; font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; margin-left: 1rem; }
</style>

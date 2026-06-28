<script lang="ts">
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

	const CHAR_W = 0.6;
	const FS_BASE    = 11;
	const FS_STEP    = 4;
	const FS_FOCUS   = 18;
	const FS_MIN     = 5;
	const ROW_H  = 40;
	const COL_GAP = 70;

	type NodePos = { x: number; y: number; fs: number; opacity: number };

	function tw(label: string, fs: number) {
		return label.length * CHAR_W * fs;
	}

	function depthOf(id: number): number {
		const parents = getParents(id);
		if (parents.length === 0) return 0;
		return 1 + depthOf(parents[0]);
	}

	function fsForDepth(depth: number): number {
		return Math.max(FS_MIN, FS_BASE - depth * FS_STEP);
	}

	// Horizontal tree layout: depth → X, vertical center of subtree → Y
	// Each leaf gets a unique Y slot. Parents are vertically centered on their children.
	// This guarantees no edge crossings.
	function buildDefault(): Record<number, NodePos> {
		const COL_W = tw('Node X', FS_BASE) + COL_GAP;
		const result: Record<number, NodePos> = {};

		// First pass: assign a leaf-slot index to every leaf, in DFS order
		let leafIndex = 0;
		const leafSlot: Record<number, number> = {};
		function assignLeaves(id: number) {
			const ch = getChildren(id);
			if (ch.length === 0) { leafSlot[id] = leafIndex++; }
			else { ch.forEach(c => assignLeaves(c)); }
		}
		assignLeaves(0);

		// Second pass: Y of a node = average Y of its children's subtrees
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

	// BFS distance
	function getDistance(a: number, b: number): number {
		if (a === b) return 0;
		const visited = new Set<number>();
		const queue: [number, number][] = [[a, 0]];
		while (queue.length) {
			const [cur, dist] = queue.shift()!;
			if (cur === b) return dist;
			if (visited.has(cur)) continue;
			visited.add(cur);
			[
				...edges.filter(([x]) => x === cur).map(([, y]) => y),
				...edges.filter(([, y]) => y === cur).map(([x]) => x)
			].forEach(n => queue.push([n, dist + 1]));
		}
		return 99;
	}

	// Focused layout: use the SAME tree positions as buildDefault,
	// shift so focused node is at center, scale font so focused depth = FS_FOCUS,
	// nodes left of focus (ancestors) grow larger, nodes right (descendants) shrink further.
	function buildFocused(fid: number): Record<number, NodePos> {
		const base = buildDefault();
		const fx = base[fid].x;
		const fy = base[fid].y;
		const focusDepth = depthOf(fid);

		const scale = 1.3;

		const result: Record<number, NodePos> = {};
		nodes.forEach(n => {
			const depthDelta = depthOf(n.id) - focusDepth;
			const fs = Math.max(FS_MIN, FS_FOCUS - depthDelta * FS_STEP);
			const absDelta = Math.abs(depthDelta);
			const opacity = absDelta === 0 ? 1 : absDelta === 1 ? 0.85 : absDelta === 2 ? 0.55 : 0.3;
			result[n.id] = {
				x: (base[n.id].x - fx) * scale,
				y: (base[n.id].y - fy) * scale,
				fs,
				opacity
			};
		});
		return result;
	}

	let target: Record<number, NodePos> = buildFocused(0);
	let anim: Record<number, NodePos> = $state(
		nodes.reduce((acc, n) => { acc[n.id] = { ...target[n.id] }; return acc; }, {} as Record<number, NodePos>)
	);

	let focusId = $state<number | null>(0);
	let birdseye = $state(false);
	let rafId = 0;

	function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

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
				const nfs = lerp(a.fs, t.fs, 0.1);
				const nop = lerp(a.opacity, t.opacity, 0.1);
				if (Math.abs(nx - t.x) > 0.05 || Math.abs(ny - t.y) > 0.05) moving = true;
				next[n.id] = { x: nx, y: ny, fs: nfs, opacity: nop };
			});
			anim = next;
			if (moving) rafId = requestAnimationFrame(step);
		};
		rafId = requestAnimationFrame(step);
	}

	function focusNode(id: number) {
		focusId = id;
		if (!birdseye) {
			target = buildFocused(id);
			startAnim();
		}
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

	function getSiblings(id: number): number[] {
		const parents = getParents(id);
		if (parents.length === 0) return [];
		return getChildren(parents[0]).filter(c => c !== id);
	}

	function getSiblingIndex(id: number): number {
		const parents = getParents(id);
		if (parents.length === 0) return 0;
		return getChildren(parents[0]).indexOf(id);
	}

	function onKeyNav(e: KeyboardEvent) {
		const cur = focusId;
		if (e.key === ' ') {
			e.preventDefault();
			if (birdseye) {
				birdseye = false;
				const returnTo = focusId ?? 0;
				target = buildFocused(returnTo);
			} else {
				birdseye = true;
				target = buildDefault();
			}
			startAnim();
			return;
		}
		if (!['h','j','k','l'].includes(e.key)) return;
		e.preventDefault();
		const from = cur ?? 0;
		let next: number | null = null;
		if (e.key === 'l') {
			const ch = getChildren(from);
			if (ch.length > 0) next = ch[0];
		} else if (e.key === 'h') {
			const par = getParents(from);
			if (par.length > 0) next = par[0];
		} else if (e.key === 'j' || e.key === 'k') {
			const fromDepth = depthOf(from);
			const base = buildDefault();
			const sameDepth = nodes
				.filter(n => depthOf(n.id) === fromDepth)
				.sort((a, b) => base[a.id].y - base[b.id].y)
				.map(n => n.id);
			const idx = sameDepth.indexOf(from);
			if (e.key === 'j' && idx < sameDepth.length - 1) next = sameDepth[idx + 1];
			else if (e.key === 'k' && idx > 0) next = sameDepth[idx - 1];
		}
		if (next !== null) focusNode(next);
	}

	// For each parent, compute the connector group:
	// - horizontal line: parent right-edge → trunk X
	// - vertical trunk: spans from first child Y to last child Y
	// - per child: horizontal branch from trunk X → child left-edge
	type ConnectorGroup = {
		parentId: number;
		hx1: number; hx2: number; hy: number;       // parent → trunk
		trunkX: number; trunkY1: number; trunkY2: number; // vertical trunk
		branches: { y: number; x2: number }[];       // trunk → each child
		opacity: number;
	};

	function buildConnectors(): ConnectorGroup[] {
		const groups: ConnectorGroup[] = [];
		const parents = [...new Set(edges.map(([a]) => a))];
		for (const pid of parents) {
			const children = getChildren(pid);
			if (children.length === 0) continue;
			const p = anim[pid];
			const pW = tw(nodes[pid].label, p.fs) / 2;
			const childPositions = children.map(cid => {
				const c = anim[cid];
				const cW = tw(nodes[cid].label, c.fs) / 2;
				return { y: c.y, x: c.x - cW, opacity: c.opacity };
			});
			// trunk X = midpoint between parent right edge and leftmost child left edge
			const parentRight = p.x + pW;
			const minChildLeft = Math.min(...childPositions.map(c => c.x));
			const trunkX = (parentRight + minChildLeft) / 2;
			const ys = childPositions.map(c => c.y);
			const trunkY1 = Math.min(...ys);
			const trunkY2 = Math.max(...ys);
			const opacity = Math.min(p.opacity, Math.min(...childPositions.map(c => c.opacity))) * 0.85;
			groups.push({
				parentId: pid,
				hx1: parentRight, hx2: trunkX, hy: p.y,
				trunkX, trunkY1, trunkY2,
				branches: childPositions.map(c => ({ y: c.y, x2: c.x })),
				opacity
			});
		}
		return groups;
	}
</script>

<svelte:head>
	<title>Tree Graph</title>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet" />
</svelte:head>

<svelte:window onkeydown={onKeyNav} />

<div class="scene">
	<svg width="100%" height="100%" viewBox="-380 -220 760 440" preserveAspectRatio="xMidYMid meet">
		<g>
			{#each buildConnectors() as cg (cg.parentId)}
				<line x1={cg.hx1} y1={cg.hy} x2={cg.hx2} y2={cg.hy} stroke="#aaa" stroke-width="0.8" opacity={cg.opacity} />
				<line x1={cg.trunkX} y1={cg.trunkY1} x2={cg.trunkX} y2={cg.trunkY2} stroke="#aaa" stroke-width="0.8" opacity={cg.opacity} />
				{#each cg.branches as b}
					<line x1={cg.trunkX} y1={b.y} x2={b.x2} y2={b.y} stroke="#aaa" stroke-width="0.8" opacity={cg.opacity} />
				{/each}
			{/each}

			{#each nodes as node}
				{@const p = anim[node.id]}
				{#if focusId === node.id}
					{@const pad = p.fs * 0.2}
					{@const w = tw(node.label, p.fs) + pad * 2}
					{@const h = p.fs * 1.1}
					<rect
						x={p.x - w / 2}
						y={p.y - h / 2 - p.fs * 0.1}
						width={w}
						height={h}
						rx={0}
						fill="#111"
						opacity={p.opacity}
					/>
				{/if}
				<text
					class="node-label"
					class:focused={focusId === node.id}
					x={p.x}
					y={p.y}
					text-anchor="middle"
					dominant-baseline="middle"
					font-size={p.fs}
					opacity={p.opacity}
					onclick={() => onClickNode(node.id)}
					role="button"
					tabindex="0"
					onkeydown={(e) => e.key === 'Enter' && onClickNode(node.id)}
				>{node.label}</text>
			{/each}
		</g>
	</svg>

	<div class="hint">
		{birdseye ? 'Space to zoom back in' : 'hjkl navigate · Space for birds eye'}
	</div>
</div>

<style>
	:global(body, html) {
		margin: 0;
		padding: 0;
		width: 100%;
		height: 100%;
		overflow: hidden;
		background: #e8e8e3;
	}

	.scene {
		width: 100vw;
		height: 100vh;
		position: relative;
	}

	.node-label {
		font-family: 'JetBrains Mono', monospace;
		font-weight: 600;
		fill: #3a3a3a;
		cursor: pointer;
		user-select: none;
		outline: none;
	}

	.node-label:hover { fill: #222; }
	.node-label.focused { fill: #f0f0eb; font-weight: 800; }

	.hint {
		position: absolute;
		top: 1rem;
		left: 50%;
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
</style>

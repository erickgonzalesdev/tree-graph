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

	let target: Record<number, NodePos> = buildDefault();
	let anim: Record<number, NodePos> = $state(
		nodes.reduce((acc, n) => { acc[n.id] = { ...target[n.id] }; return acc; }, {} as Record<number, NodePos>)
	);

	let focusId = $state<number | null>(null);
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

	function onClickNode(id: number) {
		if (focusId === id) {
			focusId = null;
			target = buildDefault();
		} else {
			focusId = id;
			target = buildFocused(id);
		}
		startAnim();
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
</svelte:head>

<div class="scene">
	<svg width="100%" height="100%" viewBox="-380 -220 760 440" preserveAspectRatio="xMidYMid meet">
		<g>
			{#each buildConnectors() as cg (cg.parentId)}
				<line x1={cg.hx1} y1={cg.hy} x2={cg.hx2} y2={cg.hy} stroke="#475569" stroke-width="0.8" opacity={cg.opacity} />
				<line x1={cg.trunkX} y1={cg.trunkY1} x2={cg.trunkX} y2={cg.trunkY2} stroke="#475569" stroke-width="0.8" opacity={cg.opacity} />
				{#each cg.branches as b}
					<line x1={cg.trunkX} y1={b.y} x2={b.x2} y2={b.y} stroke="#475569" stroke-width="0.8" opacity={cg.opacity} />
				{/each}
			{/each}

			{#each nodes as node}
				{@const p = anim[node.id]}
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
		{focusId !== null ? 'Click node again to reset' : 'Click a node to focus'}
	</div>
</div>

<style>
	:global(body, html) {
		margin: 0;
		padding: 0;
		width: 100%;
		height: 100%;
		overflow: hidden;
		background: #0f172a;
	}

	.scene {
		width: 100vw;
		height: 100vh;
		position: relative;
	}

	.node-label {
		font-family: monospace;
		font-weight: 600;
		fill: #e2e8f0;
		cursor: pointer;
		user-select: none;
		outline: none;
	}

	.node-label:hover { fill: #f59e0b; }
	.node-label.focused { fill: #818cf8; }

	.hint {
		position: absolute;
		top: 1rem;
		left: 50%;
		transform: translateX(-50%);
		color: #94a3b8;
		font-family: sans-serif;
		font-size: 0.875rem;
		background: rgba(15, 23, 42, 0.7);
		padding: 0.4rem 1rem;
		border-radius: 999px;
		pointer-events: none;
		backdrop-filter: blur(4px);
	}
</style>

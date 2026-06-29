<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { EditorView, basicSetup } from 'codemirror';
	import { markdown } from '@codemirror/lang-markdown';
	import { oneDark } from '@codemirror/theme-one-dark';
	import { vim, Vim } from '@replit/codemirror-vim';
	import { marked } from 'marked';

	// --- Types ---

	type Node    = { id: string; label: string; path: string; type?: 'dir' | 'file' };
	type NodePos = { x: number; y: number; fs: number; opacity: number };

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

	// --- Reactive tree data ---

	let nodes = $state<Node[]>([]);
	let edges = $state<[string, string][]>([]);
	let collapsed = $state<Set<string>>(new Set());

	function isHidden(id: string): boolean {
		const parents = edges.filter(([, b]) => b === id).map(([a]) => a);
		if (parents.length === 0) return false;
		const pid = parents[0];
		return collapsed.has(pid) || isHidden(pid);
	}

	let visibleNodes = $derived(nodes.filter(n => !isHidden(n.id)));
	let visibleEdges = $derived(edges.filter(([a, b]) => !isHidden(a) && !isHidden(b) && !collapsed.has(a)));

	function getChildren(id: string) {
		return visibleEdges.filter(([a]) => a === id).map(([, b]) => b);
	}
	function getAllChildren(id: string) {
		return edges.filter(([a]) => a === id).map(([, b]) => b);
	}
	function getParents(id: string) {
		return edges.filter(([, b]) => b === id).map(([a]) => a);
	}

	function rootId(): string {
		return nodes.find(n => getParents(n.id).length === 0)?.id ?? '';
	}

	// --- API ---

	async function loadTree() {
		const res = await fetch('/api/nodes');
		const data = await res.json();
		nodes = data.nodes;
		edges = data.edges;
		const rid = rootId();
		if (!rid) return;
		const fid = focusId ?? rid;
		if (focusId === null) focusId = rid;
		target = buildFocused(fid);
		// Preserve existing anim positions; snap new nodes directly to target
		const next: Record<string, NodePos> = {};
		nodes.forEach(n => {
			next[n.id] = anim[n.id] ?? { ...target[n.id] };
		});
		anim = next;
		startAnim();
	}

	async function apiCreateNode(parentPath: string, name: string): Promise<boolean> {
		const res = await fetch('/api/nodes', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ parentPath, name })
		});
		return res.ok;
	}

	async function apiDeleteNode(path: string): Promise<boolean> {
		const res = await fetch('/api/nodes', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path })
		});
		return res.ok;
	}

	async function apiMoveNode(path: string, newParentPath: string): Promise<{ ok: boolean; path?: string }> {
		const res = await fetch('/api/nodes', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'move', path, newParentPath })
		});
		if (!res.ok) return { ok: false };
		return res.json();
	}

	async function apiCopyNode(path: string, newParentPath: string, shallow = false): Promise<{ ok: boolean; path?: string }> {
		const res = await fetch('/api/nodes', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path, newParentPath, shallow })
		});
		if (!res.ok) return { ok: false };
		return res.json();
	}

	async function apiUndo(): Promise<string | null> {
		const res = await fetch('/api/undo', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'undo' })
		});
		if (!res.ok) return null;
		const data = await res.json();
		return data.ok ? (data.focusPath ?? null) : null;
	}

	async function apiRedo(): Promise<string | null> {
		const res = await fetch('/api/undo', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'redo' })
		});
		if (!res.ok) return null;
		const data = await res.json();
		return data.ok ? (data.focusPath ?? null) : null;
	}

	async function applyUndoRedo(focusPath: string | null) {
		await loadTree();
		if (!focusPath) return;
		const id = focusPath.replace(/^\//, '').replace(/\//g, '|');
		const node = nodes.find(n => n.id === id);
		if (node) {
			focusNode(id);
		} else {
			// node was deleted by this undo — focus its parent
			const parts = focusPath.split('/').filter(Boolean);
			parts.pop();
			const parentId = parts.join('|') || rootId();
			focusNode(parentId);
		}
	}

	async function apiRenameNode(path: string, newName: string): Promise<boolean> {
		const res = await fetch('/api/nodes', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path, newName })
		});
		return res.ok;
	}

	// --- Layout helpers ---

	function tw(label: string, fs: number) {
		return label.length * CHAR_W * fs;
	}

	function depthOf(id: string): number {
		const parents = getParents(id);
		return parents.length === 0 ? 0 : 1 + depthOf(parents[0]);
	}

	function fsForDepth(depth: number): number {
		return Math.max(FS_MIN, FS_BASE - depth * FS_STEP);
	}

	function buildDefault(rowH = ROW_H, colGap = COL_GAP): Record<string, NodePos> {
		if (visibleNodes.length === 0) return {};
		const COL_W = tw('Node X', FS_BASE) + colGap;
		const result: Record<string, NodePos> = {};
		const rid = rootId();

		// Compute the vertical span a subtree needs, ensuring siblings get equal slots
		function subtreeH(id: string): number {
			const ch = getChildren(id);
			if (ch.length === 0) return rowH;
			const maxChildH = Math.max(...ch.map(c => subtreeH(c)));
			return ch.length * maxChildH;
		}

		function place(id: string, depth: number, y: number) {
			result[id] = { x: depth * COL_W, y, fs: fsForDepth(depth), opacity: 1 };
			const ch = getChildren(id);
			if (ch.length === 0) return;
			const slot = Math.max(...ch.map(c => subtreeH(c)));
			const totalH = (ch.length - 1) * slot;
			ch.forEach((c, i) => place(c, depth + 1, y - totalH / 2 + i * slot));
		}
		place(rid, 0, 0);

		const xs = Object.values(result).map(p => p.x);
		const ys = Object.values(result).map(p => p.y);
		const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
		const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
		Object.values(result).forEach(p => { p.x -= cx; p.y -= cy; });
		return result;
	}

	function buildFocused(fid: string): Record<string, NodePos> {
		const base = buildDefault();
		if (!base[fid]) return base;
		const fx = base[fid].x;
		const fy = base[fid].y;
		const focusDepth = depthOf(fid);
		const scale = 1.3;
		const result: Record<string, NodePos> = {};
		visibleNodes.forEach(n => {
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

	function colAt(depth: number): string[] {
		const base = buildDefault();
		return visibleNodes
			.filter(n => depthOf(n.id) === depth)
			.sort((a, b) => (base[a.id]?.y ?? 0) - (base[b.id]?.y ?? 0))
			.map(n => n.id);
	}

	// --- Intro animation ---

	function buildIntroSequence(): Record<string, number> {
		if (visibleNodes.length === 0) return {};
		const delays: Record<string, number> = {};
		let t = 0;
		function walk(pid: string) {
			const children = getChildren(pid);
			if (children.length === 0) return;
			delays[`h-${pid}`] = t; t += SEG_DUR;
			delays[`trunk-${pid}`] = t; t += SEG_DUR;
			children.forEach((cid, bi) => {
				delays[`b-${pid}-${bi}`] = t; t += SEG_DUR;
				walk(cid);
			});
		}
		walk(rootId());
		return delays;
	}

	function buildNodeTextDelays(): Record<string, number> {
		if (visibleNodes.length === 0) return {};
		const base = buildDefault();
		const maxDepth = Math.max(...visibleNodes.map(n => depthOf(n.id)));
		const delays: Record<string, number> = {};
		let colStart = 0;
		for (let depth = 0; depth <= maxDepth; depth++) {
			const col = visibleNodes
				.filter(n => depthOf(n.id) === depth)
				.sort((a, b) => (base[a.id]?.y ?? 0) - (base[b.id]?.y ?? 0));
			let t = colStart;
			for (const n of col) {
				delays[n.id] = t;
				t += n.label.length * CHAR_DUR;
			}
			colStart = t;
		}
		return delays;
	}

	// Recomputed whenever nodes/edges change
	let introSeq     = $derived(buildIntroSequence());
	let nodeTextDelays = $derived(buildNodeTextDelays());

	// --- Animation ---

	function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

	let target = $state<Record<string, NodePos>>({});
	let anim   = $state<Record<string, NodePos>>({});
	let rafId  = 0;

	function startAnim() {
		cancelAnimationFrame(rafId);
		const step = () => {
			let moving = false;
			const next: Record<string, NodePos> = {};
			visibleNodes.forEach(n => {
				const a = anim[n.id] ?? target[n.id];
				const t = target[n.id];
				if (!a || !t) return;
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

	let focusId  = $state<string | null>(null);
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

	// Inline rename state
	let renamingId     = $state<string | null>(null);
	let renameValue    = $state('');
	let renamingIsNew  = $state(false);
	let renamingIsFile = $state(false);

	// Delete confirm state
	let confirmDeleteId = $state<string | null>(null);

	// Markdown editor / view state
	let editorNode    = $state<Node | null>(null);
	let editorContent = $state('');
	let editorMode    = $state<'edit' | 'view'>('edit');
	let editorEl      = $state<HTMLElement | null>(null);
	let editorView: EditorView | null = null;

	// Yank / move state
	let yankId   = $state<string | null>(null);
	let yankDeep = $state(false);
	let moveId   = $state<string | null>(null);

	onMount(async () => {
		await loadTree();
		requestAnimationFrame(() => { introduced = true; });
	});

	// --- Inline markdown panel ---

	async function openInlinePanel(node: Node, mode: 'view' | 'edit' = 'view') {
		if (inlineNode?.id !== node.id) {
			closeInlinePanel();
			const res = await fetch(`/api/content?path=${encodeURIComponent(node.path)}`);
			const data = await res.json();
			inlineContent = data.content ?? '';
		}
		inlineNode = node;
		inlineMode = mode;
		if (mode === 'edit') {
			await tick();
			mountInlineEditor();
		}
	}

	function mountInlineEditor() {
		if (inlineView) { inlineView.destroy(); inlineView = null; }
		if (!inlineEl) return;
		Vim.defineEx('w', '', () => { saveInline(); });
		Vim.defineEx('wq', '', () => { saveInline().then(() => { inlineMode = 'view'; if (inlineView) { inlineView.destroy(); inlineView = null; } }); });
		Vim.defineEx('q', '', () => { inlineMode = 'view'; if (inlineView) { inlineView.destroy(); inlineView = null; } });
		inlineView = new EditorView({
			doc: inlineContent,
			extensions: [
				vim(),
				basicSetup,
				markdown(),
				oneDark,
				EditorView.updateListener.of(update => {
					if (update.docChanged) inlineContent = update.state.doc.toString();
				}),
				EditorView.theme({
					'&': { height: '100%', fontSize: '13px', fontFamily: "'JetBrains Mono', monospace" },
					'.cm-scroller': { overflow: 'auto' },
					'.cm-editor': { background: '#111' },
				}),
			],
			parent: inlineEl,
		});
		(inlineView.dom as HTMLElement).focus();
	}

	async function saveInline() {
		if (!inlineNode) return;
		if (inlineView) inlineContent = inlineView.state.doc.toString();
		await fetch('/api/content', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: inlineNode.path, content: inlineContent })
		});
	}

	function closeInlinePanel() {
		if (inlineView) { inlineView.destroy(); inlineView = null; }
		inlineNode = null;
		inlineMode = 'view';
		inlineContent = '';
	}

	async function createMarkdownFile() {
		const parentId = focusId ?? rootId();
		const parent = nodes.find(n => n.id === parentId);
		if (!parent) return;
		let tempName = 'new-note';
		let suffix = 1;
		while (nodes.some(n => n.path === `${parent.path}/${tempName}.md`)) {
			tempName = `new-note-${suffix++}`;
		}
		const res = await fetch('/api/nodes', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ parentPath: parent.path, name: tempName, type: 'file' })
		});
		if (!res.ok) return;
		await loadTree();
		await tick();
		const newNode = nodes.find(n => n.path === `${parent.path}/${tempName}.md`);
		if (newNode) {
			focusNode(newNode.id);
			await tick();
			startRename(newNode.id, newNode.label, true);
			renamingIsFile = true;
		}
	}

	function focusOnMount(el: HTMLElement) { setTimeout(() => el.focus(), 0); }

	// --- Navigation ---

	function focusNode(id: string) {
		if (inlineNode && inlineNode.id !== id) { saveInline().then(() => closeInlinePanel()); }
		focusId = id;
		if (!birdseye) { target = buildFocused(id); startAnim(); }
	}

	function onClickNode(id: string) {
		if (renamingId) return;
		birdseye = false;
		if (focusId === id) {
			const node = nodes.find(n => n.id === id);
			if (node?.type === 'file' && !inlineNode) {
				openInlinePanel(node);
			} else {
				closeInlinePanel();
				focusId = null;
				target = buildDefault();
			}
		} else {
			focusNode(id);
		}
		startAnim();
	}

	// --- Node creation & rename ---

	async function createSiblingNode() {
		const cur = focusId ?? rootId();
		const curNode = nodes.find(n => n.id === cur);
		if (!curNode) return;

		const parents = getParents(cur);
		const parentNode = parents.length > 0
			? nodes.find(n => n.id === parents[0])
			: null;

		const targetPath = parentNode ? parentNode.path : curNode.path.split('/').slice(0, -1).join('/') || '/';
		const dirPath = targetPath === '/' ? '' : targetPath;
		let tempName = 'new-node';
		let suffix = 1;
		while (nodes.some(n => n.path === `${targetPath}/${tempName}` || (targetPath === '/' && n.path === `/${tempName}`))) {
			tempName = `new-node-${suffix++}`;
		}
		const ok = await apiCreateNode(dirPath, tempName);
		if (!ok) return;

		await loadTree();
		await tick();

		const expectedPath = targetPath === '/' ? `/${tempName}` : `${targetPath}/${tempName}`;
		const newNode = nodes.find(n => n.path === expectedPath);
		if (newNode) {
			focusNode(newNode.id);
			await tick();
			startRename(newNode.id, newNode.label, true);
		}
	}

	async function createChildNode() {
		const parentId = focusId ?? rootId();
		const parent = nodes.find(n => n.id === parentId);
		if (!parent) return;

		let tempName = 'new-node';
		let suffix = 1;
		while (nodes.some(n => n.path === `${parent.path}/${tempName}`)) {
			tempName = `new-node-${suffix++}`;
		}
		const ok = await apiCreateNode(parent.path, tempName);
		if (!ok) return;

		await loadTree();
		await tick();

		const newNode = nodes.find(n => n.path === `${parent.path}/${tempName}`);
		if (newNode) {
			focusNode(newNode.id);
			await tick();
			startRename(newNode.id, newNode.label, true);
		}
	}

	function startRename(id: string, currentLabel: string, isNew = false) {
		renamingId    = id;
		renameValue   = currentLabel;
		renamingIsNew = isNew;
	}

	async function commitRename() {
		if (!renamingId) return;
		const node = nodes.find(n => n.id === renamingId);
		const newName = renameValue.trim();
		renamingId = null;
		renameValue = '';
		const wasNew  = renamingIsNew;
		const wasFile = renamingIsFile;
		renamingIsNew  = false;
		renamingIsFile = false;
		if (!node || !newName) { if (wasNew) { apiDeleteNode(node!.path).then(() => loadTree()); } return; }
		if (newName === node.label && !wasNew) { return; }
		if (newName === node.label && wasNew) {
			if (wasFile) { openInlinePanel(node, 'edit'); } else { focusNode(node.id); }
			return;
		}
		const parentPath = node.path.split('/').slice(0, -1).join('/') || '/';
		const newNameWithExt = wasFile && !newName.endsWith('.md') ? `${newName}.md` : newName;
		const newPath = parentPath === '/' ? `/${newNameWithExt}` : `${parentPath}/${newNameWithExt}`;
		const newId = newPath.replace(/^\//, '').replace(/\//g, '|');
		const ok = await apiRenameNode(node.path, newName);
		if (ok) {
			await loadTree();
			focusNode(newId);
			if (wasFile) {
				const freshNode = nodes.find(n => n.id === newId);
				if (freshNode) openInlinePanel(freshNode, 'edit');
			}
		}
	}

	function cancelRename() {
		const id = renamingId;
		const isNew = renamingIsNew;
		renamingId     = null;
		renameValue    = '';
		renamingIsNew  = false;
		renamingIsFile = false;
		if (isNew && id) {
			const node = nodes.find(n => n.id === id);
			if (node) {
				const parent = getParents(id)[0] ?? rootId();
				apiDeleteNode(node.path).then(() => loadTree()).then(() => focusNode(parent));
			}
		}
	}

	function onKeyNav(e: KeyboardEvent) {
		if (inlineNode && inlineMode === 'edit') return;
		if (inlineNode && inlineMode === 'view') {
			if (e.key === 'i' || e.key === 'Enter') {
				e.preventDefault();
				inlineMode = 'edit';
				tick().then(mountInlineEditor);
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				closeInlinePanel();
				return;
			}
		}
		if (renamingId) return;
		if (e.key === 'r' && e.ctrlKey) {
			e.preventDefault();
			apiRedo().then(applyUndoRedo);
			return;
		}
		if (showCmd)    { if (e.key === 'Escape') closeCmd();    return; }
		if (showSearch) { if (e.key === 'Escape') closeSearch(); return; }

		if (e.key === ':') { e.preventDefault(); openCmd();    return; }
		if (e.key === '/') { e.preventDefault(); openSearch(); return; }
		if (e.key === '?') { showHelp = !showHelp; return; }
		if (e.key === 'Escape') { showHelp = false; confirmDeleteId = null; yankId = null; moveId = null; return; }

		if (confirmDeleteId) {
			if (e.key === 'Enter') {
				e.preventDefault();
				const node = nodes.find(n => n.id === confirmDeleteId);
				confirmDeleteId = null;
				if (node) {
					const parent = getParents(node.id)[0] ?? rootId();
					apiDeleteNode(node.path).then(() => loadTree()).then(() => focusNode(parent));
				}
			}
			return;
		}

		if (e.key === 'y' || e.key === 'Y') {
			e.preventDefault();
			if (focusId) { yankId = focusId; yankDeep = e.key === 'Y'; moveId = null; }
			return;
		}
		if (e.key === 'm') {
			e.preventDefault();
			if (focusId) { moveId = focusId; yankId = null; }
			return;
		}
		if (e.key === 'u') {
			e.preventDefault();
			apiUndo().then(applyUndoRedo);
			return;
		}
		if (e.key === 'p' || e.key === 'P') {
			e.preventDefault();
			const dest = focusId;
			if (!dest) return;
			const destNode = nodes.find(n => n.id === dest);
			if (!destNode) return;
			// p = paste as sibling (under dest's parent), P = paste as child of dest
			const pasteAsChild = e.key === 'P';
			const parentNode = pasteAsChild
				? destNode
				: (getParents(dest)[0] ? nodes.find(n => n.id === getParents(dest)[0]) : null) ?? destNode;
			if (yankId) {
				const srcNode = nodes.find(n => n.id === yankId);
				if (!srcNode) return;
				const deep = yankDeep;
				yankId = null;
				apiCopyNode(srcNode.path, parentNode.path, !deep).then(async (res) => {
					if (!res.ok) return;
					await loadTree();
					const newId = (parentNode.path + '/' + srcNode.path.split('/').pop())
						.replace(/^\//, '').replace(/\//g, '|');
					focusNode(newId);
				});
			} else if (moveId) {
				const srcNode = nodes.find(n => n.id === moveId);
				if (!srcNode) return;
				if (pasteAsChild && (dest.startsWith(moveId + '|') || dest === moveId)) return;
				moveId = null;
				apiMoveNode(srcNode.path, parentNode.path).then(async (res) => {
					if (!res.ok) return;
					await loadTree();
					const newId = (parentNode.path + '/' + srcNode.path.split('/').pop())
						.replace(/^\//, '').replace(/\//g, '|');
					focusNode(newId);
				});
			}
			return;
		}
		if (e.key === 'Tab') {
			e.preventDefault();
			if (focusId && getAllChildren(focusId).length > 0) {
				const next = new Set(collapsed);
				if (next.has(focusId)) next.delete(focusId);
				else next.add(focusId);
				collapsed = next;
				target = birdseye ? buildDefault(24, 45) : buildFocused(focusId);
				startAnim();
			}
			return;
		}
		if (e.key === 'r') {
			e.preventDefault();
			if (focusId) {
				const node = nodes.find(n => n.id === focusId);
				if (node) startRename(node.id, node.label);
			}
			return;
		}
		if (e.key === 'x') {
			e.preventDefault();
			if (focusId && focusId !== rootId()) confirmDeleteId = focusId;
			return;
		}
		if (e.key === 'n') {
			e.preventDefault();
			createMarkdownFile();
			return;
		}
		if (e.key === 'o') {
			e.preventDefault();
			createSiblingNode();
			return;
		}
		if (e.key === 'O') {
			e.preventDefault();
			createChildNode();
			return;
		}

		if (e.key === ' ') {
			e.preventDefault();
			birdseye = !birdseye;
			target = birdseye ? buildDefault(24, 45) : buildFocused(focusId ?? rootId());
			startAnim();
			return;
		}

		if (e.key === 'Enter') {
		e.preventDefault();
		if (focusId) {
			const node = nodes.find(n => n.id === focusId);
			if (node?.type === 'file') openInlinePanel(node, 'edit');
		}
		return;
	}
	if (!['h','j','k','l','H','J','K','L'].includes(e.key)) return;
		e.preventDefault();

		const from = focusId ?? rootId();
		const col = colAt(depthOf(from));
		const idx = col.indexOf(from);
		let next: string | null = null;

		switch (e.key) {
			case 'l': {
				if (collapsed.has(from)) {
					const next2 = new Set(collapsed); next2.delete(from); collapsed = next2;
					target = birdseye ? buildDefault(24, 45) : buildFocused(from); startAnim(); break;
				}
				const ch = getChildren(from); if (ch.length) next = ch[0]; break;
			}
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
		const from = focusId ?? rootId();
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
				closeCmd(); birdseye = true; target = buildDefault(24, 45); startAnim(); return;
			case 'zoom':
				closeCmd(); birdseye = false; target = buildFocused(focusId ?? rootId()); startAnim(); return;
			case 'root':
				closeCmd(); birdseye = false; focusNode(rootId()); return;
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

	type Connector =
		| { kind: 'trunk'; parentId: string; d: string; opacity: number; active: boolean }
		| { kind: 'branch'; parentId: string; childId: string; d: string; opacity: number; active: boolean };

	function isConnectedToFocus(pid: string): boolean {
		if (focusId === null) return true;
		const ch = getChildren(pid);
		return pid === focusId
			|| ch.includes(focusId)
			|| getParents(focusId).includes(pid)
			|| ch.some(c => getParents(focusId).includes(c))
			|| getParents(pid).some(p => p === focusId);
	}

	function buildConnectors(): Connector[] {
		const result: Connector[] = [];
		const parentIds = [...new Set(visibleEdges.map(([pid]) => pid))];

		for (const pid of parentIds) {
			const p = anim[pid];
			if (!p) continue;
			const children = getChildren(pid);
			if (!children.length) continue;

			const pLabel = visibleNodes.find(n => n.id === pid)?.label ?? '';
			const px1 = p.x + tw(pLabel, p.fs) / 2;

			// trunk X = midpoint between parent center and children column center
			const firstC = anim[children[0]];
			if (!firstC) continue;
			const mx = (p.x + firstC.x) / 2;

			const childYs = children.map(cid => anim[cid]?.y).filter((y): y is number => y !== undefined);
			const trunkY1 = Math.min(...childYs);
			const trunkY2 = Math.max(...childYs);
			const active = isConnectedToFocus(pid);
			const pOpacity = p.opacity;

			const trunkD = trunkY1 === trunkY2
				? `M ${px1} ${p.y} H ${mx}`
				: `M ${px1} ${p.y} H ${mx} V ${trunkY1} M ${mx} ${p.y} V ${trunkY2}`;
			result.push({
				kind: 'trunk', parentId: pid,
				d: trunkD,
				opacity: pOpacity * 0.85,
				active
			});

			// branch from trunk to each child
			for (const cid of children) {
				const c = anim[cid];
				if (!c) continue;
				const cLabel = visibleNodes.find(n => n.id === cid)?.label ?? '';
				const cx2 = c.x - tw(cLabel, c.fs) / 2;
				const opacity = Math.min(p.opacity, c.opacity) * 0.85;
				result.push({
					kind: 'branch', parentId: pid, childId: cid,
					d: `M ${mx} ${c.y} H ${cx2}`,
					opacity,
					active
				});
			}
		}
		return result;
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
			{#each buildConnectors() as ep (ep.kind === 'trunk' ? `trunk-${ep.parentId}` : `branch-${ep.parentId}-${ep.childId}`)}
				{@const delay = ep.kind === 'trunk'
					? (introSeq[`trunk-${ep.parentId}`] ?? introSeq[`h-${ep.parentId}`] ?? 0)
					: (introSeq[`b-${ep.parentId}-${getChildren(ep.parentId).indexOf(ep.childId)}`] ?? 0)}
				<path
					class="connector"
					class:introduced
					d={ep.d}
					fill="none"
					stroke={ep.active ? '#555' : '#ccc'}
					stroke-width={ep.active ? 1.2 : 0.6}
					opacity={ep.opacity}
					pathLength="1"
					style="transition: stroke 0.3s, stroke-width 0.3s; animation-delay: {delay}ms"
				/>
			{/each}

			{#each visibleNodes as node}
				{@const p = anim[node.id]}
				{#if p}
					{#if yankId === node.id || moveId === node.id}
						{@const pad = p.fs * 0.2}
						{@const w = tw(node.label, p.fs) + pad * 2}
						<rect
							x={p.x - w / 2}
							y={p.y - p.fs * 1.1 / 2 - p.fs * 0.1}
							width={w}
							height={p.fs * 1.1}
							fill={yankId === node.id ? '#2a4a2a' : '#4a2a2a'}
							opacity={p.opacity}
						/>
					{/if}
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

					{#if renamingId === node.id}
						{@const rw = Math.max(tw(renameValue || 'new-node', p.fs) + p.fs * 2, 80)}
						<foreignObject
							x={p.x - rw / 2}
							y={p.y - p.fs * 0.9}
							width={rw}
							height={p.fs * 1.8}
						>
							<input
								class="rename-input"
								bind:value={renameValue}
								style="font-size: {p.fs}px; width: 100%; height: 100%;"
								onkeydown={(e) => {
									if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
									if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
								}}
								use:focusOnMount
							/>
						</foreignObject>
					{:else}
						<text
							class="node-label"
							class:focused={focusId === node.id}
							x={p.x} y={p.y}
							text-anchor="middle"
							dominant-baseline="middle"
							font-size={p.fs}
							opacity={p.opacity}
							onclick={() => {
								if (node.type === 'file' && focusId === node.id) { openInlinePanel(node); }
								else { onClickNode(node.id); }
							}}
							role="button"
							tabindex="0"
							onkeydown={(e) => { if (e.key === 'Enter') { if (node.type === 'file') openInlinePanel(node); else onClickNode(node.id); } }}
						>{#each node.label.split('') as char, ci}<tspan
								class="char"
								class:introduced
								style="animation-delay: {(nodeTextDelays[node.id] ?? 0) + ci * CHAR_DUR}ms"
							>{char}</tspan>{/each}{#if node.type === 'file'}<tspan class="file-badge"> ¶</tspan>{/if}</text>
						{#if collapsed.has(node.id)}
							{@const childCount = getAllChildren(node.id).length}
							<text
								class="collapsed-badge"
								x={p.x + tw(node.label, p.fs) / 2 + p.fs * 0.5}
								y={p.y}
								dominant-baseline="middle"
								font-size={p.fs * 0.75}
								opacity={p.opacity * 0.7}
							>▸{childCount}</text>
						{/if}
					{/if}
				{/if}

				{#if inlineNode?.id === node.id}
					{@const PANEL_W = 320}
					{@const PANEL_H = 220}
					{@const px_off = tw(node.label, p.fs) / 2 + 14}
					{@const sc = Math.max(0.5, Math.min(2, p.fs / 11))}
					<foreignObject
						x={p.x + px_off}
						y={p.y - (PANEL_H * sc) / 2}
						width={PANEL_W * sc}
						height={PANEL_H * sc}
						opacity={p.opacity}
					>
						<div class="inline-panel" style="width:{PANEL_W}px; height:{PANEL_H}px; transform: scale({sc}); transform-origin: top left;">
							{#if inlineMode === 'edit'}
								<div class="inline-edit" bind:this={inlineEl}></div>
							{:else}
								<div class="inline-view">{@html marked(inlineContent)}</div>
							{/if}
							<div class="inline-hint">
								{#if inlineMode === 'edit'}vim · :w :wq :q{:else}i/Enter edit · Esc close{/if}
							</div>
						</div>
					</foreignObject>
				{/if}
			{/each}
		</g>
	</svg>

	<div class="hint">
		{#if yankId}
			<span style="color:#6a9a6a">{yankDeep ? 'Y' : 'y'}</span> yanked ({yankDeep ? 'subtree' : 'node only'}) · navigate · <span style="color:#6a9a6a">p</span> sibling · <span style="color:#6a9a6a">P</span> child · Esc cancel
		{:else if moveId}
			<span style="color:#9a6a6a">m</span> marked · navigate · <span style="color:#9a6a6a">p</span> sibling · <span style="color:#9a6a6a">P</span> child · Esc cancel
		{:else if birdseye}
			Space to zoom back in
		{:else}
			hjkl navigate · o sibling · O child · <span class="hint-btn" onclick={openSearch}>/ search</span> · Space birds eye · ? help
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

	{#if confirmDeleteId}
		{@const delNode = nodes.find(n => n.id === confirmDeleteId)}
		<div class="confirm-overlay" role="dialog" aria-modal="true" onclick={() => confirmDeleteId = null}>
			<div class="confirm-box" onclick={(e) => e.stopPropagation()}>
				<div class="confirm-title">Delete "{delNode?.label}"?</div>
				<div class="confirm-sub">This will delete the directory and all its contents.</div>
				<div class="confirm-btns">
					<button class="confirm-btn confirm-yes" onclick={async () => {
						const node = nodes.find(n => n.id === confirmDeleteId);
						confirmDeleteId = null;
						if (!node) return;
						const parent = getParents(node.id)[0] ?? rootId();
						await apiDeleteNode(node.path);
						await loadTree();
						focusNode(parent);
					}}>Yes, delete</button>
					<button class="confirm-btn confirm-no" onclick={() => confirmDeleteId = null}>Cancel</button>
				</div>
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
						<tr><td>Tab</td><td>Collapse / expand node</td></tr>
						<tr><td>r</td><td>Rename focused node</td></tr>
					<tr><td>y / Y</td><td>Yank node only / with subtree</td></tr>
					<tr><td>m</td><td>Mark node for move</td></tr>
					<tr><td>p / P</td><td>Paste as sibling / as child</td></tr>
					<tr><td>u</td><td>Undo</td></tr>
					<tr><td>Ctrl+r</td><td>Redo</td></tr>
					<tr><td>n</td><td>Create markdown file in focused node</td></tr>
					<tr><td>o</td><td>Create sibling node (same column)</td></tr>
					<tr><td>O</td><td>Create child node (next column)</td></tr>
					<tr><td>x</td><td>Delete focused node</td></tr>
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
	.collapsed-badge { font-family: 'JetBrains Mono', monospace; fill: #888; user-select: none; pointer-events: none; }

	.rename-input {
		width: 100%;
		height: 100%;
		box-sizing: border-box;
		background: #111;
		color: #f0f0eb;
		border: none;
		outline: none;
		font-family: 'JetBrains Mono', monospace;
		font-weight: 600;
		text-align: center;
		padding: 0 0.3em;
		caret-color: #f0f0eb;
		display: block;
	}

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

	.confirm-overlay {
		position: fixed; inset: 0;
		background: rgba(0,0,0,0.4);
		display: flex; align-items: center; justify-content: center;
		z-index: 30;
	}
	.confirm-box {
		background: #1a1a1a;
		border: 1px solid #555;
		padding: 1.5rem 2rem;
		font-family: 'JetBrains Mono', monospace;
		min-width: 20rem;
	}
	.confirm-title { font-size: 0.95rem; font-weight: 700; color: #e8e8e3; margin-bottom: 0.5rem; }
	.confirm-sub   { font-size: 0.78rem; color: #888; margin-bottom: 1.25rem; }
	.confirm-btns  { display: flex; gap: 0.75rem; }
	.confirm-btn   { font-family: 'JetBrains Mono', monospace; font-size: 0.82rem; border: 1px solid #555; padding: 0.35rem 1rem; cursor: pointer; background: transparent; }
	.confirm-yes   { color: #e06c75; border-color: #e06c75; }
	.confirm-yes:hover { background: #e06c75; color: #1a1a1a; }
	.confirm-no    { color: #888; }
	.confirm-no:hover  { background: #333; color: #e8e8e3; }

	.file-badge { fill: #888; font-size: 0.8em; }
	.node-label.focused .file-badge { fill: #a0a09b; }

	.inline-panel {
		display: flex; flex-direction: column;
		background: #111;
		border: 1px solid #333;
		box-sizing: border-box;
		overflow: hidden;
	}
	.inline-view {
		flex: 1; overflow-y: auto; overflow-x: hidden;
		padding: 8px 10px;
		color: #c8c8c0; font-size: 12px; line-height: 1.55;
		font-family: 'JetBrains Mono', monospace;
	}
	.inline-edit {
		flex: 1; min-height: 0; overflow: hidden;
	}
	.inline-hint {
		flex-shrink: 0; padding: 2px 8px;
		background: #0d0d0d; border-top: 1px solid #1e1e1e;
		color: #555; font-size: 10px; font-family: 'JetBrains Mono', monospace;
	}
	:global(.inline-view h1, .inline-view h2, .inline-view h3) { color: #e8e8e3; margin: 0.5em 0 0.25em; font-size: 1em; }
	:global(.inline-view p) { margin: 0.3em 0; }
	:global(.inline-view code) { background: #1e1e1e; padding: 0.05em 0.25em; }
	:global(.inline-view pre) { background: #1a1a1a; padding: 0.4em 0.6em; overflow-x: auto; }
	:global(.inline-view ul, .inline-view ol) { padding-left: 1.2em; margin: 0.3em 0; }
	:global(.inline-view a) { color: #7a9fd4; }
</style>

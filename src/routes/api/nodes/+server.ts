import { json, error } from '@sveltejs/kit';
import { promises as fs } from 'fs';
import { join, basename } from 'path';
import { cwd } from 'process';
import { pushUndo, snapshotBefore, CONTENT_ROOT } from '../history';

async function copyDir(src: string, dest: string) {
	await fs.mkdir(dest, { recursive: true });
	const entries = await fs.readdir(src, { withFileTypes: true });
	for (const e of entries) {
		if (e.isDirectory()) await copyDir(join(src, e.name), join(dest, e.name));
		else await fs.copyFile(join(src, e.name), join(dest, e.name));
	}
}

type NodeData = { id: string; label: string; path: string; parentId: string | null };
type TreeResponse = { nodes: NodeData[]; edges: [string, string][] };

async function scanDir(dirPath: string, parentId: string | null, result: TreeResponse) {
	const id = dirPath.slice(CONTENT_ROOT.length + 1).replace(/\//g, '|');
	result.nodes.push({ id, label: basename(dirPath), path: dirPath.slice(CONTENT_ROOT.length), parentId });
	if (parentId !== null) result.edges.push([parentId, id]);

	const entries = await fs.readdir(dirPath, { withFileTypes: true });
	const dirs = entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
	for (const dir of dirs) {
		await scanDir(join(dirPath, dir.name), id, result);
	}
}

export async function GET() {
	const result: TreeResponse = { nodes: [], edges: [] };
	const entries = await fs.readdir(CONTENT_ROOT, { withFileTypes: true });
	const dirs = entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
	for (const dir of dirs) {
		await scanDir(join(CONTENT_ROOT, dir.name), null, result);
	}
	return json(result);
}

export async function POST({ request }) {
	const { parentPath, name } = await request.json();
	if (!name || name.includes('/') || name.includes('..')) error(400, 'invalid name');
	const relPath = join(parentPath, name);
	const newPath = join(CONTENT_ROOT, relPath);
	try {
		await fs.mkdir(newPath);
	} catch (e: any) {
		if (e.code === 'EEXIST') error(409, 'already exists');
		error(500, e.message);
	}
	pushUndo({ type: 'create', path: relPath });
	return json({ ok: true, path: relPath });
}

export async function DELETE({ request }) {
	const { path } = await request.json();
	if (!path || path === '/') error(400, 'cannot delete root');
	const target = join(CONTENT_ROOT, path);
	if (!target.startsWith(CONTENT_ROOT + '/')) error(400, 'invalid path');
	const snapshot = await snapshotBefore(path);
	try {
		await fs.rm(target, { recursive: true });
	} catch (e: any) {
		error(500, e.message);
	}
	pushUndo({ type: 'delete', path, snapshot });
	return json({ ok: true });
}

export async function PATCH({ request }) {
	const body = await request.json();
	if (body.action === 'move') {
		const { path, newParentPath } = body;
		const src = join(CONTENT_ROOT, path);
		const relDest = join(newParentPath, basename(path));
		const dest = join(CONTENT_ROOT, relDest);
		if (!src.startsWith(CONTENT_ROOT + '/')) error(400, 'invalid path');
		if (!dest.startsWith(CONTENT_ROOT + '/')) error(400, 'invalid newParentPath');
		if (dest.startsWith(src + '/') || dest === src) error(400, 'cannot move into itself');
		try {
			await fs.rename(src, dest);
		} catch (e: any) {
			error(500, e.message);
		}
		pushUndo({ type: 'move', oldPath: path, newPath: relDest });
		return json({ ok: true, path: relDest });
	}
	const { path, newName } = body;
	if (!newName || newName.includes('/') || newName.includes('..')) error(400, 'invalid name');
	const oldPath = join(CONTENT_ROOT, path);
	const parentDir = join(CONTENT_ROOT, path, '..');
	const relNew = join(path, '..', newName);
	const newPath = join(parentDir, newName);
	try {
		await fs.rename(oldPath, newPath);
	} catch (e: any) {
		error(500, e.message);
	}
	pushUndo({ type: 'rename', oldPath: path, newPath: relNew });
	return json({ ok: true });
}

export async function PUT({ request }) {
	const { path, newParentPath, shallow } = await request.json();
	const src = join(CONTENT_ROOT, path);
	const relDest = join(newParentPath, basename(path));
	const dest = join(CONTENT_ROOT, relDest);
	if (!src.startsWith(CONTENT_ROOT + '/')) error(400, 'invalid path');
	if (!dest.startsWith(CONTENT_ROOT + '/')) error(400, 'invalid newParentPath');
	if (dest.startsWith(src + '/') || dest === src) error(400, 'cannot copy into itself');
	try {
		if (shallow) {
			await fs.mkdir(dest);
		} else {
			await copyDir(src, dest);
		}
	} catch (e: any) {
		if (e.code === 'EEXIST') error(409, 'already exists');
		error(500, e.message);
	}
	pushUndo({ type: 'copy', destPath: relDest });
	return json({ ok: true, path: relDest });
}

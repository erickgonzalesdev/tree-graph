import { json, error } from '@sveltejs/kit';
import { promises as fs } from 'fs';
import { join, basename } from 'path';
import { cwd } from 'process';

const CONTENT_ROOT = join(cwd(), 'content');

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
	if (!name || name.includes('/') || name.includes('..')) {
		error(400, 'invalid name');
	}
	const newPath = join(CONTENT_ROOT, parentPath, name);
	try {
		await fs.mkdir(newPath);
	} catch (e: any) {
		if (e.code === 'EEXIST') error(409, 'already exists');
		error(500, e.message);
	}
	return json({ ok: true, path: join(parentPath, name) });
}

export async function DELETE({ request }) {
	const { path } = await request.json();
	if (!path || path === '/') error(400, 'cannot delete root');
	const target = join(CONTENT_ROOT, path);
	if (!target.startsWith(CONTENT_ROOT + '/')) error(400, 'invalid path');
	try {
		await fs.rm(target, { recursive: true });
	} catch (e: any) {
		error(500, e.message);
	}
	return json({ ok: true });
}

export async function PATCH({ request }) {
	const { path, newName } = await request.json();
	if (!newName || newName.includes('/') || newName.includes('..')) {
		error(400, 'invalid name');
	}
	const oldPath = join(CONTENT_ROOT, path);
	const newPath = join(CONTENT_ROOT, path, '..', newName);
	try {
		await fs.rename(oldPath, newPath);
	} catch (e: any) {
		error(500, e.message);
	}
	return json({ ok: true });
}

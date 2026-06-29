import { promises as fs } from 'fs';
import { join, basename } from 'path';
import { cwd } from 'process';

export const CONTENT_ROOT = join(cwd(), 'content');

export type UndoAction =
	| { type: 'create';  path: string }
	| { type: 'delete';  path: string; snapshot: string }
	| { type: 'rename';  oldPath: string; newPath: string }
	| { type: 'move';    oldPath: string; newPath: string }
	| { type: 'copy';    destPath: string };

export const undoStack: UndoAction[] = [];
export const redoStack: UndoAction[] = [];

export function pushUndo(action: UndoAction) {
	undoStack.push(action);
	redoStack.length = 0;
}

async function snapshotDir(dirPath: string): Promise<string> {
	const snapDir = join(CONTENT_ROOT, '..', '.tree-snapshots');
	await fs.mkdir(snapDir, { recursive: true });
	const name = `snap-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const dest = join(snapDir, name);
	await copyDir(dirPath, dest);
	return dest;
}

async function copyDir(src: string, dest: string) {
	await fs.mkdir(dest, { recursive: true });
	const entries = await fs.readdir(src, { withFileTypes: true });
	for (const e of entries) {
		if (e.isDirectory()) await copyDir(join(src, e.name), join(dest, e.name));
		else await fs.copyFile(join(src, e.name), join(dest, e.name));
	}
}

export async function snapshotBefore(path: string): Promise<string> {
	return snapshotDir(join(CONTENT_ROOT, path));
}

export async function applyUndo(action: UndoAction): Promise<UndoAction> {
	switch (action.type) {
		case 'create': {
			await fs.rm(join(CONTENT_ROOT, action.path), { recursive: true });
			return { type: 'delete', path: action.path, snapshot: '' };
		}
		case 'delete': {
			await copyDir(action.snapshot, join(CONTENT_ROOT, action.path));
			return { type: 'create', path: action.path };
		}
		case 'rename': {
			await fs.rename(join(CONTENT_ROOT, action.newPath), join(CONTENT_ROOT, action.oldPath));
			return { type: 'rename', oldPath: action.newPath, newPath: action.oldPath };
		}
		case 'move': {
			await fs.rename(join(CONTENT_ROOT, action.newPath), join(CONTENT_ROOT, action.oldPath));
			return { type: 'move', oldPath: action.newPath, newPath: action.oldPath };
		}
		case 'copy': {
			await fs.rm(join(CONTENT_ROOT, action.destPath), { recursive: true });
			return { type: 'create', path: action.destPath };
		}
	}
}

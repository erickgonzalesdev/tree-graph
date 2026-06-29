import { json, error } from '@sveltejs/kit';
import { promises as fs } from 'fs';
import { join } from 'path';
import { CONTENT_ROOT, pushUndo } from '../history';

export async function GET({ url }) {
	const path = url.searchParams.get('path');
	if (!path) error(400, 'missing path');
	const abs = join(CONTENT_ROOT, path);
	if (!abs.startsWith(CONTENT_ROOT + '/')) error(400, 'invalid path');
	try {
		const content = await fs.readFile(abs, 'utf-8');
		return json({ content });
	} catch (e: any) {
		if (e.code === 'ENOENT') error(404, 'not found');
		error(500, e.message);
	}
}

export async function PUT({ request }) {
	const { path, content } = await request.json();
	if (!path) error(400, 'missing path');
	const abs = join(CONTENT_ROOT, path);
	if (!abs.startsWith(CONTENT_ROOT + '/')) error(400, 'invalid path');
	try {
		await fs.writeFile(abs, content ?? '', 'utf-8');
	} catch (e: any) {
		error(500, e.message);
	}
	return json({ ok: true });
}

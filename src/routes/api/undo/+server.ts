import { json, error } from '@sveltejs/kit';
import { undoStack, redoStack, applyUndo, type UndoAction } from '../history';

function focusPathForOp(op: UndoAction): string {
	switch (op.type) {
		case 'create':  return op.path;
		case 'delete':  return op.path;
		case 'rename':  return op.oldPath;
		case 'move':    return op.oldPath;
		case 'copy':    return op.destPath;
	}
}

export async function POST({ request }) {
	const { action } = await request.json();
	if (action === 'undo') {
		if (!undoStack.length) return json({ ok: false, reason: 'nothing to undo' });
		const op = undoStack.pop()!;
		const focusPath = focusPathForOp(op);
		try {
			const inverse = await applyUndo(op);
			redoStack.push(inverse);
		} catch (e: any) {
			undoStack.push(op);
			error(500, e.message);
		}
		return json({ ok: true, focusPath, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
	}
	if (action === 'redo') {
		if (!redoStack.length) return json({ ok: false, reason: 'nothing to redo' });
		const op = redoStack.pop()!;
		const focusPath = focusPathForOp(op);
		try {
			const inverse = await applyUndo(op);
			undoStack.push(inverse);
		} catch (e: any) {
			redoStack.push(op);
			error(500, e.message);
		}
		return json({ ok: true, focusPath, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
	}
	error(400, 'unknown action');
}

export async function GET() {
	return json({ canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
}

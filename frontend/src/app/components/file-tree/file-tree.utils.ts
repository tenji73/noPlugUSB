import type { DriveFile } from '../../services/drive.service';

export type FileTreeNode =
	| { kind: 'folder'; label: string; pathKey: string; children: FileTreeNode[] }
	| { kind: 'file'; file: DriveFile };

export type FileTreeSortKey = 'name' | 'date' | 'size';
export type FileTreeSortDir = 'asc' | 'desc';

export type FileTreeBuildOptions = {
	sortKey?: FileTreeSortKey;
	sortDir?: FileTreeSortDir;
};

type MutableChild =
	| { kind: 'folder'; label: string; pathKey: string; children: MutableChild[] }
	| { kind: 'file'; file: DriveFile };

function compareFiles(a: DriveFile, b: DriveFile, key: FileTreeSortKey, dir: FileTreeSortDir): number {
	const sign = dir === 'desc' ? -1 : 1;
	if (key === 'name') {
		return sign * a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
	}
	if (key === 'size') {
		return sign * ((a.sizeBytes ?? 0) - (b.sizeBytes ?? 0));
	}
	const ta = new Date(a.dateModified).getTime();
	const tb = new Date(b.dateModified).getTime();
	const na = Number.isFinite(ta) ? ta : 0;
	const nb = Number.isFinite(tb) ? tb : 0;
	return sign * (na - nb);
}

function sortMutable(children: MutableChild[], sortKey: FileTreeSortKey, sortDir: FileTreeSortDir): void {
	children.sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
		if (a.kind === 'folder' && b.kind === 'folder') {
			return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
		}
		if (a.kind === 'file' && b.kind === 'file') {
			return compareFiles(a.file, b.file, sortKey, sortDir);
		}
		return 0;
	});
	for (const c of children) {
		if (c.kind === 'folder') sortMutable(c.children, sortKey, sortDir);
	}
}

/** Marker file written for empty folders; not shown as a file row (see buildFileTree). */
export const FOLDER_PLACEHOLDER_NAME = '.noplugdir';

/**
 * Build a folder tree from flat catalog entries. Uses `relativePath` (POSIX);
 * entries without a folder segment stay at the volume root.
 */
export function buildFileTree(files: DriveFile[], options?: FileTreeBuildOptions): FileTreeNode[] {
	const sortKey = options?.sortKey ?? 'name';
	const sortDir = options?.sortDir ?? 'asc';
	const root: MutableChild = { kind: 'folder', label: '', pathKey: '', children: [] };

	for (const f of files) {
		const rel = f.relativePath?.replace(/\\/g, '/').trim() ?? '';
		const isDirPlaceholder = f.name === FOLDER_PLACEHOLDER_NAME;

		if (!rel || !rel.includes('/')) {
			if (isDirPlaceholder) {
				continue;
			}
			root.children.push({ kind: 'file', file: f });
			continue;
		}
		const parts = rel.split('/').filter(Boolean);
		if (isDirPlaceholder) {
			if (parts.length < 1 || parts[parts.length - 1] !== FOLDER_PLACEHOLDER_NAME) {
				continue;
			}
			const folderParts = parts.slice(0, -1);
			let node = root;
			let prefix = '';
			for (const seg of folderParts) {
				prefix = prefix ? `${prefix}/${seg}` : seg;
				let next = node.children.find(
					(c): c is Extract<MutableChild, { kind: 'folder' }> =>
						c.kind === 'folder' && c.pathKey === prefix,
				);
				if (!next) {
					next = { kind: 'folder', label: seg, pathKey: prefix, children: [] };
					node.children.push(next);
				}
				node = next;
			}
			continue;
		}
		const pathParts = [...parts];
		pathParts.pop();
		let node = root;
		let prefix = '';
		for (const seg of pathParts) {
			prefix = prefix ? `${prefix}/${seg}` : seg;
			let next = node.children.find(
				(c): c is Extract<MutableChild, { kind: 'folder' }> =>
					c.kind === 'folder' && c.pathKey === prefix,
			);
			if (!next) {
				next = { kind: 'folder', label: seg, pathKey: prefix, children: [] };
				node.children.push(next);
			}
			node = next;
		}
		node.children.push({ kind: 'file', file: f });
	}

	sortMutable(root.children, sortKey, sortDir);
	return root.children as FileTreeNode[];
}

import { Component, input, output } from '@angular/core';
import type { DriveFile } from '../../services/drive.service';
import { CommonModule } from '@angular/common';
import { HighlightPipe } from '../../pipes/highlight.pipe';
import { FOLDER_PLACEHOLDER_NAME, type FileTreeNode } from './file-tree.utils';
import { formatBytes } from '../../utils/bytes';
import { fontAwesomeFileIconClass } from '../../utils/file-icons';

/** Folder row identity for HTML5 drag-and-drop (tree folders are not `DriveFile`). */
export type FolderDropRow = { pathKey: string; label: string };

export type FileDragPayload = { event: DragEvent; file: DriveFile };
export type FolderDragPayload = { event: DragEvent; folder: FolderDropRow };

@Component({
	selector: 'app-file-tree',
	standalone: true,
	imports: [CommonModule, FileTreeComponent, HighlightPipe],
	templateUrl: './file-tree.html',
})
export class FileTreeComponent {
	nodes = input.required<FileTreeNode[]>();
	/** Folders whose pathKey is in the set are expanded (default: none → all collapsed). */
	expandedKeys = input.required<Set<string>>();
	depth = input(0);
	/** When true, file action buttons are hidden/disabled (e.g. volume connected to host). */
	actionsDisabled = input(false);
	/** Highlights the folder row whose `pathKey` matches while dragging over it. */
	dropTargetPathKey = input<string | null>(null);
	/** File ids that should show the icon instead of a failed thumbnail image. */
	thumbnailFailedIds = input<ReadonlySet<string>>(new Set());
	/** Current file search text — matches are wrapped with {@link HighlightPipe}. */
	filterHighlight = input<string>('');
	folderToggle = output<string>();
	fileDragStart = output<FileDragPayload>();
	fileDragEnd = output<DragEvent>();
	folderDragStart = output<FolderDragPayload>();
	folderDragEnd = output<DragEvent>();
	folderDragOver = output<FolderDragPayload>();
	folderDragLeave = output<FolderDragPayload>();
	folderDrop = output<FolderDragPayload>();
	fileRename = output<DriveFile>();
	fileDelete = output<DriveFile>();
	fileDownload = output<DriveFile>();
	/** Parent folder `pathKey` (POSIX path from root) — open “new subfolder” for this directory. */
	folderSubfolder = output<string>();
	/** Delete this folder and all contents (after confirmation in parent). */
	folderDelete = output<string>();
	/** Emitted when a file-row thumbnail `<img>` fails to load (404, etc.). */
	fileThumbnailError = output<Event>();

	readonly formatBytes = formatBytes;
	readonly faFile = fontAwesomeFileIconClass;
	/** Hidden marker file for empty folders — not rendered as a row. */
	readonly folderPlaceholderName = FOLDER_PLACEHOLDER_NAME;

	isExpanded(pathKey: string): boolean {
		return this.expandedKeys().has(pathKey);
	}

	onFolderClick(pathKey: string): void {
		this.folderToggle.emit(pathKey);
	}

	formatDate(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	}

	trackNode(_: number, node: FileTreeNode): string {
		return node.kind === 'folder' ? node.pathKey : node.file.id;
	}

	/** Uses `thumbnailURL` from the file list when the server has generated a WebP. */
	thumbnailUrlFor(file: DriveFile): string | null {
		const u = file.thumbnailURL;
		return u != null && u !== '' ? u : null;
	}
}

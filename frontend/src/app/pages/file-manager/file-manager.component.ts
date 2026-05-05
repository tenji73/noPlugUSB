import {
	Component,
	computed,
	DestroyRef,
	HostListener,
	inject,
	NgZone,
	OnInit,
	signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import {
	HttpErrorResponse,
	HttpEvent,
	HttpEventType,
	HttpResponse,
} from '@angular/common/http';
import { ActivatedRoute, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { EMPTY, of } from 'rxjs';
import { catchError, filter, finalize, map, switchMap, take, tap } from 'rxjs/operators';
import {
	DriveService,
	Drive,
	DriveFile,
	DriveUploadResponse,
	SystemState,
} from '../../services/drive.service';
import { DriveStateNotifyService } from '../../services/drive-state-notify.service';
import { ThumbnailEventsService } from '../../services/thumbnail-events.service';
import { ToastService } from '../../components/toast/toast.service';
import { formatBytes } from '../../utils/bytes';
import { UsbService } from '../../services/usb.service';
import { DialogService } from '../../components/dialog/dialog.service';
import { defaultDialogConfig } from '../../dialog-ui';
import {
	DialogUniversalComponent,
	type UniversalDialogData,
	UniversalDialogResult,
} from '../../components/dialog/dialog-universal.component';
import {
	DriveFormDialogComponent,
	DriveFormDialogData,
} from '../../components/dialogs/drive-form-dialog.component';
import { DriveCardComponent } from '../../components/drive-card/drive-card.component';
import {
	buildFileTree,
	type FileTreeSortKey,
} from '../../components/file-tree/file-tree.utils';
import { FileTreeComponent, type FolderDropRow } from '../../components/file-tree/file-tree';
import { displayNameToBinFilename } from '../../utils/drive-filename';

/** In-tree drag source: a file row or a folder row (moves the whole directory on the server). */
type DraggingItem =
	| { kind: 'file'; file: DriveFile }
	| { kind: 'folder'; pathKey: string; label: string };

@Component({
	selector: 'app-file-manager',
	standalone: true,
	imports: [CommonModule, RouterLink, RouterLinkActive, FileTreeComponent, DriveCardComponent],
	templateUrl: './file-manager.component.html',
	host: { class: 'flex min-h-0 flex-1 flex-col' },
})
export class FileManagerComponent implements OnInit {
	private route = inject(ActivatedRoute);
	private router = inject(Router);
	private driveService = inject(DriveService);
	private driveStateNotify = inject(DriveStateNotifyService);
	private usbService = inject(UsbService);
	private dialog = inject(DialogService);
	private destroyRef = inject(DestroyRef);
	private ngZone = inject(NgZone);
	private thumbnailEvents = inject(ThumbnailEventsService);
	private toast = inject(ToastService);

	/** USB / dialog ops from sidebar — disables actions while in flight. */
	usbBusy = signal(false);
	busyDriveId = signal<string | null>(null);
	busyLabel = signal('');

	sidebarDrives = signal<Drive[]>([]);
	systemState = signal<SystemState | null>(null);
	currentDrive = signal<Drive | null>(null);
	files = signal<DriveFile[]>([]);
	loadingFiles = signal(false);
	/** In-flight refresh from {@link refreshFileList} (same overlay as initial load). */
	refreshingFiles = signal(false);
	notFound = signal(false);
	connectedBlock = signal(false);

	/** Rebuilding all cached thumbnails for the open drive (POST /thumbnails/regenerate). */
	thumbRegenerateBusy = signal(false);

	isDragging = signal(false);
	isUploading = signal(false);
	uploadProgress = signal(0);
	/** HTTP body finished (100%) but server still writing to the volume (e.g. loop-mounted image). */
	isProcessingOnHardware = signal(false);

	/** Folder drop / webkitdirectory: awaiting Keep vs Flatten choice (in-memory snapshots). */
	pendingUploadFiles: File[] = [];
	/** Paths captured at drop time; synthetic Files from snapshots lose `webkitRelativePath`. */
	pendingRelativePaths: string[] = [];
	/** Signal so the modal updates when async file reads finish (often outside NgZone after Chrome prompts). */
	showFolderPrompt = signal(false);

	/** Shown between the title and action icons when hovering those controls (avoids floating tooltips). */
	headerActionHint = signal<string | null>(null);

	/**
	 * Monotonic id for file-list fetches so overlapping requests don't clear the wrong busy flag.
	 * Incremented on route drive change and on each {@link refreshFileList} start.
	 */
	private fileListOpSeq = 0;

	/** Full-screen busy: initial load or reload of the file catalog. */
	readonly fileListBusy = computed(() => this.loadingFiles() || this.refreshingFiles());

	/** Search / filter (flat catalog) before building the tree. */
	fileFilterQuery = signal('');
	/** Sort files within each folder; folders stay grouped first, sorted by label. */
	sortKey = signal<FileTreeSortKey>('name');
	sortDir = signal<'asc' | 'desc'>('asc');

	readonly sortToolbarOptions: { key: FileTreeSortKey; label: string }[] = [
		{ key: 'name', label: 'Name' },
		{ key: 'date', label: 'Date' },
		{ key: 'size', label: 'Size' },
	];

	/** Catalog entries matching the search box (full list when empty). */
	filteredFiles = computed(() => {
		const q = this.fileFilterQuery().trim().toLowerCase();
		const files = this.files();
		if (!q) return files;
		return files.filter((f) => {
			const name = f.name.toLowerCase();
			const rel = (f.relativePath || '').toLowerCase().replace(/\\/g, '/');
			const ext = (f.extension || '').toLowerCase();
			const extBare = ext.replace(/^\./, '');
			return (
				name.includes(q) ||
				rel.includes(q) ||
				ext.includes(q) ||
				extBare.includes(q.replace(/^\./, ''))
			);
		});
	});

	/** Nested folder/file tree for volumes that use `relativePath`. */
	fileTree = computed(() =>
		buildFileTree(this.filteredFiles(), {
			sortKey: this.sortKey(),
			sortDir: this.sortDir(),
		}),
	);
	/** Folder `pathKey`s in this set are expanded (default: none → all directories start closed). */
	expandedFolderKeys = signal<Set<string>>(new Set());

	/** HTML5 drag-and-drop: file or folder row being moved onto another folder. */
	draggingItem = signal<DraggingItem | null>(null);
	/** Folder row currently highlighted as drop target. */
	dragTargetFolder = signal<FolderDropRow | null>(null);
	/** Root drop area highlighted while dragging a file/folder. */
	rootDropActive = signal(false);
	private readonly rootDropRow: FolderDropRow = { pathKey: '', label: 'Volume root' };
	/** File ids whose thumbnail `<img>` failed to load (show Font Awesome fallback). */
	thumbnailFailedIds = signal<Set<string>>(new Set());

	readonly formatBytes = formatBytes;

	isDriveActive(drive: Drive): boolean {
		return this.systemState()?.activeDriveId === drive.id;
	}

	cardBusy(drive: Drive): boolean {
		return this.busyDriveId() === drive.id;
	}

	cardInterlocked(drive: Drive): boolean {
		return this.usbBusy() || this.cardBusy(drive);
	}

	onFileFilterInput(event: Event): void {
		const el = event.target as HTMLInputElement;
		this.fileFilterQuery.set(el.value);
	}

	onSortOptionClick(key: FileTreeSortKey): void {
		if (this.sortKey() === key) {
			this.sortDir.update((d) => (d === 'asc' ? 'desc' : 'asc'));
		} else {
			this.sortKey.set(key);
			this.sortDir.set('asc');
		}
	}

	clearFileFilter(): void {
		this.fileFilterQuery.set('');
	}

	bytesUsedOnDrive(d: Drive): number {
		if (this.currentDrive()?.id === d.id) {
			return this.files().reduce((acc, f) => acc + (f.sizeBytes ?? 0), 0);
		}
		return d.usedBytes ?? 0;
	}

	manageFilesFromCard(drive: Drive): void {
		if (this.cardInterlocked(drive) || this.isDriveActive(drive)) return;
		void this.router.navigate(['/files', drive.id]);
	}

	backupDrive(drive: Drive): void {
		if (this.cardInterlocked(drive) || this.isDriveActive(drive)) return;
		const ref = this.dialog.open<DialogUniversalComponent, UniversalDialogResult>(DialogUniversalComponent, {
			...defaultDialogConfig(),
			data: {
				title: 'Backup this virtual device?',
				message:
					'On the Raspberry Pi, the backup will download the actual disk image. In virtual mode, this button downloads a demo JSON manifest (metadata + file list) for now.',
				confirmLabel: 'Download backup',
				cancelLabel: 'Cancel',
				variant: 'warning',
			} satisfies UniversalDialogData,
		});
		ref.afterClosed().subscribe((confirmed) => {
			if (confirmed !== true) return;
			this.driveService
				.getFiles(drive.id)
				.pipe(take(1))
				.subscribe({
					next: (files) => {
						const manifest = {
							version: 1,
							createdAt: new Date().toISOString(),
							drive: {
								displayName: drive.displayName,
								description: drive.description,
								size: drive.size,
								format: drive.format,
								icon: drive.icon,
								themeColor: drive.themeColor,
								filename: drive.filename,
							},
							files: files.map((f) => ({
								name: f.name,
								sizeBytes: f.sizeBytes,
								dateModified: f.dateModified,
								extension: f.extension,
								relativePath: f.relativePath ?? '',
							})),
						};
						const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
						const url = URL.createObjectURL(blob);
						const a = document.createElement('a');
						a.href = url;
						a.download = displayNameToBinFilename(drive.displayName).replace(/\.bin$/i, '-backup.json');
						a.click();
						URL.revokeObjectURL(url);
						this.toast.success('Backup downloaded', 'Backup manifest JSON saved.');
					},
					error: () => {
						this.toast.error('Could not download backup', 'Check that the API is reachable.');
					},
				});
		});
	}

	onConnect(drive: Drive): void {
		if (this.cardInterlocked(drive)) return;

		const activeId = this.systemState()?.activeDriveId;
		if (activeId && activeId !== drive.id) {
			const activeDrive = this.sidebarDrives().find((d) => d.id === activeId);
			const activeName = activeDrive?.displayName ?? activeId;
			const ref = this.dialog.open<DialogUniversalComponent, UniversalDialogResult>(DialogUniversalComponent, {
				...defaultDialogConfig(),
				data: {
					title: 'Switch virtual USB device?',
					message: `“${activeName}” is currently connected to the host. Connecting “${drive.displayName}” will disconnect that device first, then expose this volume as USB storage.\n\nContinue?`,
					confirmLabel: 'Switch and connect',
					cancelLabel: 'Cancel',
					variant: 'warning',
					messageMinHeight: '120px',
				} satisfies UniversalDialogData,
			});
			ref.afterClosed().subscribe((r) => {
				if (r === true) {
					this.performConnect(drive);
				}
			});
			return;
		}

		this.performConnect(drive);
	}

	private performConnect(drive: Drive): void {
		this.usbBusy.set(true);
		this.setCardBusy(drive.id, 'Connecting…');
		this.usbService
			.connectPrinter(drive.id)
			.pipe(
				switchMap(() => this.driveService.getFullState()),
				finalize(() => {
					this.usbBusy.set(false);
					this.clearCardBusy();
				}),
			)
			.subscribe({
				next: (s) => this.driveStateNotify.notify(s),
				error: () => {},
			});
	}

	requestDisconnect(): void {
		if (this.usbBusy() || this.busyDriveId()) return;
		const activeId = this.systemState()?.activeDriveId;
		if (!activeId) return;

		const ref = this.dialog.open<DialogUniversalComponent, UniversalDialogResult>(DialogUniversalComponent, {
			...defaultDialogConfig(),
			data: {
				title: 'Disconnect from device?',
				message:
					'Host Device Warning: Disconnecting the virtual drive while the host is actively accessing it (e.g., printing, playing media, or milling) may result in data loss or system errors. Proceed with disconnect?',
				confirmLabel: 'Disconnect',
				cancelLabel: 'Cancel',
				variant: 'warning',
			} satisfies UniversalDialogData,
		});
		ref.afterClosed().subscribe((r) => {
			if (r === true) {
				this.performDisconnect(activeId);
			}
		});
	}

	private performDisconnect(activeDriveId: string): void {
		this.usbBusy.set(true);
		this.setCardBusy(activeDriveId, 'Disconnecting…');
		this.usbService
			.disconnectPrinter()
			.pipe(
				switchMap(() => this.driveService.getFullState()),
				finalize(() => {
					this.usbBusy.set(false);
					this.clearCardBusy();
				}),
			)
			.subscribe({
				next: (s) => this.driveStateNotify.notify(s),
				error: () => {},
			});
	}

	openEditDrive(drive: Drive): void {
		if (this.cardInterlocked(drive)) return;
		const ref = this.dialog.open<DriveFormDialogComponent, boolean>(DriveFormDialogComponent, {
			...defaultDialogConfig(),
			data: {
				mode: 'edit',
				drive,
				otherDrives: this.sidebarDrives().filter((x) => x.id !== drive.id),
			} satisfies DriveFormDialogData,
		});
		ref.afterClosed().subscribe((saved) => {
			if (!saved) return;
			this.setCardBusy(drive.id, 'Updating…');
			this.driveService
				.getFullState()
				.pipe(finalize(() => this.clearCardBusy()))
				.subscribe({
					next: (s) => this.driveStateNotify.notify(s),
					error: () => this.clearCardBusy(),
				});
		});
	}

	requestDelete(drive: Drive): void {
		if (this.cardInterlocked(drive)) return;
		const ref = this.dialog.open<DialogUniversalComponent, UniversalDialogResult>(DialogUniversalComponent, {
			...defaultDialogConfig(),
			data: {
				title: 'Delete this drive permanently?',
				message: `This removes “${drive.displayName}” from the device list and deletes its .bin disk image on the Raspberry Pi. All data on that image is lost. There is no undo.`,
				confirmLabel: 'Delete permanently',
				cancelLabel: 'Cancel',
				variant: 'danger',
			} satisfies UniversalDialogData,
		});
		ref.afterClosed().subscribe((r) => {
			if (r !== true) return;
			this.setCardBusy(drive.id, 'Deleting…');
			this.driveService
				.deleteDrive(drive.id)
				.pipe(finalize(() => this.clearCardBusy()))
				.subscribe({
					next: (s) => {
						this.driveStateNotify.notify(s);
						if (this.route.snapshot.paramMap.get('driveId') === drive.id) {
							void this.router.navigate(['/']);
						}
					},
					error: () => {},
				});
		});
	}

	private setCardBusy(driveId: string, label: string): void {
		this.busyDriveId.set(driveId);
		this.busyLabel.set(label);
	}

	private clearCardBusy(): void {
		this.busyDriveId.set(null);
		this.busyLabel.set('');
	}

	/**
	 * Approximate free bytes: drive capacity (`Drive.size` is bytes) minus listed file sizes.
	 * Aligns pre-flight checks with the catalog shown in this view.
	 */
	getFreeSpaceBytes(): number {
		const drive = this.currentDrive();
		if (!drive) return 0;
		const capacity = drive.size;
		const listed = this.files().reduce((acc, f) => acc + (f.sizeBytes ?? 0), 0);
		return Math.max(0, capacity - listed);
	}

	toggleFolder(pathKey: string): void {
		const next = new Set(this.expandedFolderKeys());
		if (next.has(pathKey)) next.delete(pathKey);
		else next.add(pathKey);
		this.expandedFolderKeys.set(next);
	}

	private fileParentPathKey(f: DriveFile): string | null {
		const rel = f.relativePath?.replace(/\\/g, '/').trim();
		if (!rel || !rel.includes('/')) return null;
		const dir = rel.slice(0, rel.lastIndexOf('/'));
		return dir.length ? dir : null;
	}

	private folderParentPathKey(pathKey: string): string | null {
		const i = pathKey.lastIndexOf('/');
		if (i <= 0) return null;
		return pathKey.slice(0, i);
	}

	private canDropOnFolder(item: DraggingItem, folder: FolderDropRow): boolean {
		if (item.kind === 'file') {
			// Treat "no parent folder segment" as moving to volume root (`pathKey === ''`).
			return (this.fileParentPathKey(item.file) ?? '') !== folder.pathKey;
		}
		const src = item.pathKey;
		if (src === folder.pathKey) return false;
		if (folder.pathKey.startsWith(`${src}/`)) return false;
		if ((this.folderParentPathKey(src) ?? '') === folder.pathKey) return false;
		return true;
	}

	private expandPathKeys(posixPath: string): void {
		const parts = posixPath.split('/').filter(Boolean);
		let acc = '';
		this.expandedFolderKeys.update((keys) => {
			const next = new Set(keys);
			for (const p of parts) {
				acc = acc ? `${acc}/${p}` : p;
				next.add(acc);
			}
			return next;
		});
	}

	onDragStart(event: DragEvent, file: DriveFile): void {
		this.draggingItem.set({ kind: 'file', file });
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
			event.dataTransfer.setData('text/plain', file.id);
		}
	}

	onFolderDragStart(event: DragEvent, folder: FolderDropRow): void {
		this.draggingItem.set({ kind: 'folder', pathKey: folder.pathKey, label: folder.label });
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
			event.dataTransfer.setData('text/plain', folder.pathKey);
		}
	}

	onDragOverRoot(event: DragEvent): void {
		event.preventDefault();
		event.stopPropagation();
		const item = this.draggingItem();
		if (!item || this.connectedBlock()) return;
		if (!this.canDropOnFolder(item, this.rootDropRow)) {
			this.rootDropActive.set(false);
			return;
		}
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'move';
		}
		this.dragTargetFolder.set(null);
		this.rootDropActive.set(true);
	}

	onDragLeaveRoot(event: DragEvent): void {
		event.preventDefault();
		this.rootDropActive.set(false);
	}

	onDropOnRoot(event: DragEvent): void {
		event.preventDefault();
		event.stopPropagation();
		const item = this.draggingItem();
		if (item && this.canDropOnFolder(item, this.rootDropRow)) {
			this.performMove(item, this.rootDropRow);
		}
		this.draggingItem.set(null);
		this.dragTargetFolder.set(null);
		this.rootDropActive.set(false);
	}

	onDragOverFolder(event: DragEvent, folder: FolderDropRow): void {
		event.preventDefault();
		event.stopPropagation();
		const item = this.draggingItem();
		if (!item || !this.canDropOnFolder(item, folder)) return;
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'move';
		}
		this.dragTargetFolder.set(folder);
	}

	onDragLeaveFolder(event: DragEvent, folder: FolderDropRow): void {
		event.preventDefault();
		if (this.dragTargetFolder()?.pathKey === folder.pathKey) {
			this.dragTargetFolder.set(null);
		}
	}

	onDropIntoFolder(event: DragEvent, folder: FolderDropRow): void {
		event.preventDefault();
		event.stopPropagation();
		const item = this.draggingItem();
		if (item && this.canDropOnFolder(item, folder)) {
			this.performMove(item, folder);
		}
		this.draggingItem.set(null);
		this.dragTargetFolder.set(null);
	}

	onDragEnd(_event: DragEvent): void {
		this.draggingItem.set(null);
		this.dragTargetFolder.set(null);
	}

	handleImageError(event: Event): void {
		const el = event.target as HTMLImageElement | null;
		const id = el?.dataset['thumbFileId'];
		if (id) {
			this.thumbnailFailedIds.update((s) => new Set(s).add(id));
		}
	}

	private performMove(item: DraggingItem, folder: FolderDropRow): void {
		if (this.connectedBlock()) return;
		const id = this.route.snapshot.paramMap.get('driveId');
		if (!id) return;
		const sourceLogicalPath =
			item.kind === 'file' ? this.logicalKeyForCatalog(item.file) : item.pathKey;
		this.driveService.moveDriveItem(id, sourceLogicalPath, folder.pathKey).subscribe({
			next: (res) => {
				this.expandPathKeys(folder.pathKey);
				if (res.kind === 'folder') {
					this.expandPathKeys(res.path);
				}
				this.refreshFileList(id);
				this.toast.success('Moved.');
			},
			error: (e: unknown) => {
				let msg = 'Could not move.';
				if (e instanceof HttpErrorResponse) {
					const body = e.error as { error?: string; code?: string } | null;
					if (e.status === 409) {
						msg = body?.error ?? 'Something already exists at that location.';
					} else if (e.status === 404) {
						msg = body?.error ?? 'Item not found.';
					} else if (e.status === 400) {
						msg = body?.error ?? msg;
					}
				}
				this.toast.error('Could not move', msg);
			},
		});
	}

	cancelFolderUpload(): void {
		this.pendingUploadFiles = [];
		this.pendingRelativePaths = [];
		this.showFolderPrompt.set(false);
	}

	confirmFolderUpload(flatten: boolean): void {
		const raw = this.pendingUploadFiles;
		const paths = this.pendingRelativePaths;
		this.pendingUploadFiles = [];
		this.pendingRelativePaths = [];
		this.showFolderPrompt.set(false);

		if (!raw.length) return;

		const id = this.route.snapshot.paramMap.get('driveId');
		if (!id || this.connectedBlock()) {
			this.toast.error('Cannot upload', 'This volume is connected to the host.');
			return;
		}

		let files: File[];
		let relativePaths: string[];

		if (flatten) {
			files = raw.map((f, i) => {
				const rp = (paths[i] || f.name).replace(/\\/g, '/');
				const flatName = rp.split('/').join(' - ');
				return new File([f], flatName, { type: f.type, lastModified: f.lastModified });
			});
			relativePaths = files.map(() => '');
		} else {
			files = [...raw];
			relativePaths = paths.map((p) => p.replace(/\\/g, '/'));
		}

		this.startUploadAfterChecks(id, files, relativePaths);
	}

	/**
	 * Read dropped files into memory immediately (same user-gesture turn as drop).
	 * Otherwise Chrome may deny reading the original handles after the folder modal closes (net::ERR_ACCESS_DENIED).
	 */
	private snapshotFolderFilesForPrompt(files: File[], relativePaths: string[]): void {
		const reads = files.map((f) =>
			f.arrayBuffer().then(
				(buf) => new File([buf], f.name, { type: f.type, lastModified: f.lastModified }),
			),
		);
		Promise.all(reads)
			.then((snapshots) => {
				this.ngZone.run(() => {
					this.pendingUploadFiles = snapshots;
					this.pendingRelativePaths = relativePaths;
					this.showFolderPrompt.set(true);
				});
			})
			.catch(() => {
				this.ngZone.run(() => {
					this.toast.error('Could not read folder', 'Try again or use Upload folder.');
				});
			});
	}

	@HostListener('window:dragover', ['$event'])
	onWindowDragOver(event: DragEvent): void {
		if (!event.dataTransfer?.types?.includes('Files')) return;
		event.preventDefault();
	}

	ngOnInit(): void {
		this.driveStateNotify.state$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((s) => {
			const prevIds = new Set(this.sidebarDrives().map((d) => d.id));
			const added = s.drives.filter((d) => !prevIds.has(d.id));
			/** Single new catalog entry — go there so the user can upload (skip if sidebar not loaded yet but many drives exist). */
			const soleNewDrive =
				added.length === 1 && (prevIds.size > 0 || s.drives.length === 1) ? added[0] : null;

			this.sidebarDrives.set(s.drives);
			this.systemState.set(s.systemState);

			if (soleNewDrive) {
				void this.router.navigate(['/files', soleNewDrive.id]);
				return;
			}

			const id = this.route.snapshot.paramMap.get('driveId');
			if (!id) return;
			const drive = s.drives.find((d) => d.id === id) ?? null;
			this.currentDrive.set(drive);
			if (!drive) {
				this.notFound.set(true);
				this.files.set([]);
				this.connectedBlock.set(false);
				return;
			}
			this.notFound.set(false);
			if (s.systemState.activeDriveId === id) {
				this.connectedBlock.set(true);
				this.files.set([]);
			} else {
				this.connectedBlock.set(false);
				this.refreshFileList(id);
			}
		});

		this.route.paramMap
			.pipe(
				map((p) => p.get('driveId')),
				switchMap((id) => {
					if (!id) {
						this.notFound.set(true);
						this.sidebarDrives.set([]);
						this.currentDrive.set(null);
						this.files.set([]);
						this.thumbnailFailedIds.set(new Set());
						this.loadingFiles.set(false);
						return EMPTY;
					}
					this.thumbnailFailedIds.set(new Set());
					this.files.set([]);
					this.headerActionHint.set(null);
					this.fileListOpSeq++;
					this.refreshingFiles.set(false);
					/** Instant feedback + header title while state/files load */
					const quick = this.sidebarDrives().find((d) => d.id === id);
					if (quick) {
						this.currentDrive.set(quick);
					}
					this.loadingFiles.set(true);
					return this.driveService.getFullState().pipe(
						catchError(() => {
							this.notFound.set(true);
							this.sidebarDrives.set([]);
							this.loadingFiles.set(false);
							return EMPTY;
						}),
						switchMap((s) => {
							this.sidebarDrives.set(s.drives);
							this.systemState.set(s.systemState);
							const drive = s.drives.find((d) => d.id === id) ?? null;
							this.currentDrive.set(drive);
							if (!drive) {
								this.notFound.set(true);
								this.files.set([]);
								this.connectedBlock.set(false);
								this.loadingFiles.set(false);
								return EMPTY;
							}
							this.notFound.set(false);
							if (s.systemState.activeDriveId === id) {
								this.connectedBlock.set(true);
								this.files.set([]);
								this.loadingFiles.set(false);
								return EMPTY;
							}
							this.connectedBlock.set(false);
							return this.driveService.getFiles(id).pipe(
								finalize(() => this.loadingFiles.set(false)),
								catchError(() => of([])),
							);
						}),
					);
				}),
				takeUntilDestroyed(this.destroyRef),
			)
			.subscribe({
				next: (list) => {
					this.files.set(list ?? []);
					this.thumbnailFailedIds.set(new Set());
				},
				error: () => this.files.set([]),
			});

		this.thumbnailEvents.thumbnailReady$
			.pipe(takeUntilDestroyed(this.destroyRef))
			.subscribe((ev) => {
				if (ev.driveId !== this.currentDrive()?.id) return;
				this.applyThumbnailFromSocket(ev);
			});
	}

	private applyThumbnailFromSocket(ev: {
		driveId: string;
		storagePath: string;
		thumbnailURL: string;
	}): void {
		const want = ev.storagePath.replace(/\\/g, '/').trim();
		const url = `${ev.thumbnailURL}${ev.thumbnailURL.includes('?') ? '&' : '?'}v=${Date.now()}`;
		this.files.update((list) =>
			list.map((f) => (this.logicalKeyForCatalog(f) === want ? { ...f, thumbnailURL: url } : f)),
		);
		const failed = new Set(this.thumbnailFailedIds());
		for (const f of this.files()) {
			if (this.logicalKeyForCatalog(f) === want) {
				failed.delete(f.id);
			}
		}
		this.thumbnailFailedIds.set(failed);
	}

	private refreshFileList(driveId: string): void {
		const op = ++this.fileListOpSeq;
		this.refreshingFiles.set(true);
		this.driveService
			.getFiles(driveId)
			.pipe(
				finalize(() => {
					if (op === this.fileListOpSeq) {
						this.refreshingFiles.set(false);
					}
				}),
			)
			.subscribe({
				next: (list) => {
					if (this.route.snapshot.paramMap.get('driveId') !== driveId) {
						return;
					}
					this.files.set(list);
					this.thumbnailFailedIds.set(new Set());
				},
				error: () => {},
			});
	}

	onRegenerateThumbnails(): void {
		if (this.connectedBlock() || this.thumbRegenerateBusy()) return;
		const id = this.route.snapshot.paramMap.get('driveId');
		if (!id) return;
		this.thumbRegenerateBusy.set(true);
		this.driveService
			.regenerateThumbnails(id)
			.pipe(finalize(() => this.thumbRegenerateBusy.set(false)))
			.subscribe({
				next: (r) => {
					this.toast.success(`Regenerated ${r.processed} thumbnail(s).`);
					if (r.errors?.length) {
						this.toast.error(r.errors.slice(0, 5).join(' · '));
					}
					this.refreshFileList(id);
				},
				error: () => this.toast.error('Could not regenerate thumbnails'),
			});
	}

	private logicalKeyForCatalog(f: DriveFile): string {
		const r = f.relativePath?.replace(/\\/g, '/').trim() ?? '';
		return r && r.length > 0 ? r : f.name;
	}

	private logicalPathForUpload(rel: string, fileName: string): string {
		const r = (rel || '').replace(/\\/g, '/').trim();
		return r && r.length > 0 ? r : fileName;
	}

	private pathHasLeadingDotSegment(posixPath: string): boolean {
		return posixPath.split('/').filter(Boolean).some((s) => s.startsWith('.'));
	}

	private insertBeforeExt(filename: string, suffix: string): string {
		const dot = filename.lastIndexOf('.');
		if (dot <= 0) return `${filename}${suffix}`;
		return `${filename.slice(0, dot)}${suffix}${filename.slice(dot)}`;
	}

	private uniqueLogicalPath(baseLogical: string, used: Set<string>): string {
		if (!used.has(baseLogical)) return baseLogical;
		const lastSlash = baseLogical.lastIndexOf('/');
		const dir = lastSlash >= 0 ? baseLogical.slice(0, lastSlash) : '';
		const baseName = lastSlash >= 0 ? baseLogical.slice(lastSlash + 1) : baseLogical;
		for (let n = 2; n < 10000; n++) {
			const nb = this.insertBeforeExt(baseName, ` (${n})`);
			const candidate = dir ? `${dir}/${nb}` : nb;
			if (!used.has(candidate)) return candidate;
		}
		return `${baseLogical}_${Date.now()}`;
	}

	/** Indices that clash with the volume catalog or with an earlier file in this batch. */
	private indicesNeedingResolution(relativePaths: string[], files: File[]): number[] {
		const existing = new Set(this.files().map((f) => this.logicalKeyForCatalog(f)));
		const accepted = new Set<string>();
		const need: number[] = [];
		for (let i = 0; i < files.length; i++) {
			const logical = this.logicalPathForUpload(relativePaths[i] ?? '', files[i].name);
			if (existing.has(logical) || accepted.has(logical)) {
				need.push(i);
			} else {
				accepted.add(logical);
			}
		}
		return need;
	}

	private resolveRenamedUploads(
		relativePaths: string[],
		files: File[],
		conflictIndices: number[],
	): { paths: string[]; fileNames: string[] } {
		const existing = new Set(this.files().map((f) => this.logicalKeyForCatalog(f)));
		const paths = [...relativePaths];
		const fileNames = files.map((f) => f.name);
		const conflictSet = new Set(conflictIndices);

		for (let i = 0; i < files.length; i++) {
			if (!conflictSet.has(i)) {
				existing.add(this.logicalPathForUpload(paths[i] ?? '', files[i].name));
			}
		}
		for (const i of conflictIndices) {
			const logical = this.logicalPathForUpload(paths[i] ?? '', files[i].name);
			const next = this.uniqueLogicalPath(logical, existing);
			existing.add(next);
			if (next.includes('/')) {
				paths[i] = next;
				fileNames[i] = next.slice(next.lastIndexOf('/') + 1);
			} else {
				paths[i] = '';
				fileNames[i] = next;
			}
		}
		return { paths, fileNames };
	}

	onFileRename(file: DriveFile): void {
		if (this.connectedBlock()) return;
		const id = this.route.snapshot.paramMap.get('driveId');
		if (!id) return;
		const ref = this.dialog.open<DialogUniversalComponent, UniversalDialogResult>(DialogUniversalComponent, {
			...defaultDialogConfig(),
			data: {
				title: 'Rename file',
				message: 'Enter a new file name.',
				showPrompt: true,
				prompt: file.name,
				promptPlaceholder: 'File name',
				confirmLabel: 'Rename',
				cancelLabel: 'Cancel',
			} satisfies UniversalDialogData,
		});
		ref.afterClosed().subscribe((r) => {
			if (typeof r !== 'string') return;
			const next = r.trim();
			if (!next || next === file.name) return;
			this.driveService.renameDriveFile(id, file.id, next).subscribe({
				next: () => this.refreshFileList(id),
				error: (e: unknown) => {
					let msg = 'Could not rename file.';
					if (e instanceof HttpErrorResponse) {
						if (e.status === 409) msg = 'That name is already used on this volume.';
						else if (e.status === 400) {
							msg =
								(e.error as { error?: string } | null)?.error ??
								'Names cannot start with a period (.).';
						}
					}
					this.toast.error('Could not rename', msg);
				},
			});
		});
	}

	onFileDelete(file: DriveFile): void {
		if (this.connectedBlock()) return;
		const id = this.route.snapshot.paramMap.get('driveId');
		if (!id) return;
		const ref = this.dialog.open<DialogUniversalComponent, UniversalDialogResult>(DialogUniversalComponent, {
			...defaultDialogConfig(),
			data: {
				title: 'Delete this file?',
				message: `“${file.name}” will be removed from this volume. This cannot be undone.`,
				confirmLabel: 'Delete',
				cancelLabel: 'Cancel',
				variant: 'danger',
			} satisfies UniversalDialogData,
		});
		ref.afterClosed().subscribe((r) => {
			if (r !== true) return;
			this.driveService.deleteDriveFile(id, file.id).subscribe({
				next: () => this.refreshFileList(id),
				error: () => {
					this.toast.error('Could not delete file');
				},
			});
		});
	}

	onFileDownload(file: DriveFile): void {
		if (this.connectedBlock()) return;
		const id = this.route.snapshot.paramMap.get('driveId');
		if (!id) return;
		this.driveService.downloadDriveFile(id, file.id).subscribe({
			next: (blob) => {
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = file.name;
				a.click();
				URL.revokeObjectURL(url);
			},
			error: () => {
				this.toast.error('Could not download file');
			},
		});
	}

	/** @param parentPathKey — when set, the new folder is created under this path (from tree “New subfolder”). */
	onCreateFolder(parentPathKey?: string): void {
		if (this.connectedBlock()) return;
		const id = this.route.snapshot.paramMap.get('driveId');
		if (!id) return;
		const ref = this.dialog.open<DialogUniversalComponent, UniversalDialogResult>(DialogUniversalComponent, {
			...defaultDialogConfig(),
			data: {
				title: parentPathKey ? 'New subfolder' : 'New folder',
				message: parentPathKey
					? `Create a folder inside “${parentPathKey}”. Enter a name or nested path (e.g. 2024 or drafts/jan). No segment may start with “.”.`
					: 'Path from the volume root. Use / for nested folders. No segment may start with “.”. Examples: Photos or Photos/2024.',
				showPrompt: true,
				prompt: '',
				promptPlaceholder: parentPathKey ? 'Subfolder name' : 'MyFolder',
				confirmLabel: 'Create',
				cancelLabel: 'Cancel',
			} satisfies UniversalDialogData,
		});
		ref.afterClosed().subscribe((r) => {
			if (typeof r !== 'string') return;
			const inner = r.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
			if (!inner) return;
			const fullPath = parentPathKey ? `${parentPathKey}/${inner}` : inner;
			if (this.pathHasLeadingDotSegment(fullPath)) {
				this.toast.error('Invalid name', 'File and folder names cannot start with a period (.).');
				return;
			}
			this.driveService.createDriveFolder(id, fullPath).subscribe({
				next: (res) => {
					if (res.path) {
						const keys = new Set(this.expandedFolderKeys());
						if (parentPathKey) {
							keys.add(parentPathKey);
						}
						const parts = res.path.split('/').filter(Boolean);
						let acc = '';
						for (const seg of parts) {
							acc = acc ? `${acc}/${seg}` : seg;
							keys.add(acc);
						}
						this.expandedFolderKeys.set(keys);
					}
					this.toast.success('Folder created');
					this.refreshFileList(id);
				},
				error: (e: unknown) => {
					let msg = 'Could not create folder.';
					if (e instanceof HttpErrorResponse) {
						const body = e.error as { error?: string } | null;
						if (e.status === 409) {
							msg = body?.error ?? 'Something already exists at that path.';
						} else if (e.status === 400) {
							msg = body?.error ?? 'Invalid folder path.';
						}
					}
					this.toast.error('Could not create folder', msg);
				},
			});
		});
	}

	onDeleteFolder(pathKey: string): void {
		if (this.connectedBlock()) return;
		const id = this.route.snapshot.paramMap.get('driveId');
		if (!id) return;
		const ref = this.dialog.open<DialogUniversalComponent, UniversalDialogResult>(DialogUniversalComponent, {
			...defaultDialogConfig(),
			data: {
				title: 'Delete folder permanently?',
				noticeBanner: {
					tone: 'amber',
					body: 'This will permanently delete this folder and all files and subfolders inside it. This cannot be undone.',
				},
				message: `Folder:\n${pathKey}\n\nClick “Delete everything” to confirm, or Cancel to keep this folder.`,
				confirmLabel: 'Delete everything',
				cancelLabel: 'Cancel',
				variant: 'danger',
				messageMinHeight: '88px',
			} satisfies UniversalDialogData,
		});
		ref.afterClosed().subscribe((r) => {
			if (r !== true) return;
			this.driveService.deleteDriveFolder(id, pathKey).subscribe({
				next: () => {
					const keys = new Set(this.expandedFolderKeys());
					for (const k of [...keys]) {
						if (k === pathKey || k.startsWith(`${pathKey}/`)) {
							keys.delete(k);
						}
					}
					this.expandedFolderKeys.set(keys);
					this.toast.success('Folder deleted');
					this.refreshFileList(id);
				},
				error: (e: unknown) => {
					let msg = 'Could not delete folder.';
					if (e instanceof HttpErrorResponse) {
						const body = e.error as { error?: string } | null;
						if (e.status === 404) msg = body?.error ?? 'Folder not found.';
						else if (e.status === 400) msg = body?.error ?? msg;
					}
					this.toast.error('Could not delete folder', msg);
				},
			});
		});
	}

	private runUpload(
		driveId: string,
		files: File[],
		relativePaths: string[],
		options: { overwrite?: boolean; fileNames?: string[] } = {},
	): void {
		this.isUploading.set(true);
		this.uploadProgress.set(0);
		this.isProcessingOnHardware.set(false);
		const count = files.length;

		const titleBeforeUpload = document.title;
		const setTabTitleProgress = (pct: number) => {
			document.title = `${pct}% · ${titleBeforeUpload}`;
		};
		setTabTitleProgress(0);

		this.driveService
			.uploadFiles(driveId, files, relativePaths, options)
			.pipe(
				tap((ev: HttpEvent<DriveUploadResponse>) => {
					if (ev.type === HttpEventType.UploadProgress && ev.total != null && ev.total > 0) {
						const pct = Math.round((100 * ev.loaded) / ev.total);
						this.uploadProgress.set(pct);
						setTabTitleProgress(pct);
						if (ev.loaded === ev.total) {
							this.isProcessingOnHardware.set(true);
						}
					}
				}),
				filter(
					(ev: HttpEvent<DriveUploadResponse>): ev is HttpResponse<DriveUploadResponse> =>
						ev.type === HttpEventType.Response,
				),
				finalize(() => {
					document.title = titleBeforeUpload;
					this.isProcessingOnHardware.set(false);
				}),
			)
			.subscribe({
				next: () => {
					this.isUploading.set(false);
					this.uploadProgress.set(100);
					this.toast.success('Upload complete', `Uploaded ${count} file(s).`);
					this.refreshFileList(driveId);
				},
				error: (err: unknown) => {
					this.isUploading.set(false);
					this.uploadProgress.set(0);
					let msg = 'Upload failed.';
					if (err instanceof HttpErrorResponse) {
						if (err.status === 409) {
							msg = 'A file with that path already exists. Try again and choose Replace or Rename.';
						} else if (err.status === 400) {
							msg =
								(err.error as { error?: string })?.error ??
								'Names cannot start with a period (.).';
						}
					}
					this.toast.error('Upload failed', msg);
				},
			});
	}

	onDragOver(event: DragEvent): void {
		event.preventDefault();
		event.stopPropagation();
		if (event.dataTransfer?.types?.includes('Files')) {
			this.isDragging.set(true);
		}
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'copy';
		}
	}

	onDragLeave(event: DragEvent): void {
		event.preventDefault();
		event.stopPropagation();
		const el = event.currentTarget as HTMLElement;
		const rel = event.relatedTarget as Node | null;
		if (rel && el.contains(rel)) return;
		this.isDragging.set(false);
	}

	onDrop(event: DragEvent): void {
		event.preventDefault();
		event.stopPropagation();
		this.isDragging.set(false);
		const dt = event.dataTransfer?.files;
		if (dt?.length) {
			this.handleFiles(dt, { fromDataTransfer: true });
		}
	}

	onFilesSelected(event: Event): void {
		const input = event.target as HTMLInputElement;
		const list = input.files;
		if (list?.length) {
			this.handleFiles(list, { fromDataTransfer: false });
		}
		input.value = '';
	}

	handleFiles(
		fileList: FileList | null,
		options: { fromDataTransfer: boolean } = { fromDataTransfer: false },
	): void {
		if (!fileList?.length) return;
		const arr = Array.from(fileList).filter((f) => f.size > 0);
		if (!arr.length) return;

		const id = this.route.snapshot.paramMap.get('driveId');
		if (!id || this.connectedBlock()) {
			this.toast.error('Cannot upload', 'This volume is connected to the host.');
			return;
		}

		const relativePaths = arr.map((f) => (f.webkitRelativePath || '').replace(/\\/g, '/'));

		if (options.fromDataTransfer) {
			const hasFolders = relativePaths.some((p) => p.includes('/') || p.includes('\\'));
			if (!hasFolders) {
				/**
				 * Do not call `arrayBuffer()` on dropped files: it duplicates the whole file in RAM and
				 * fails for multi‑GiB files (browser limits). `HttpClient` + `FormData` can stream the
				 * original `File` handles, same as the file picker path.
				 */
				this.startUploadAfterChecks(id, arr, relativePaths.map(() => ''));
				return;
			}
			const reads = arr.map((f) =>
				f.arrayBuffer().then(
					(buf) => new File([buf], f.name, { type: f.type, lastModified: f.lastModified }),
				),
			);
			Promise.all(reads)
				.then((snapshots) => {
					this.ngZone.run(() => this.continueAfterSnapshot(id, snapshots, relativePaths));
				})
				.catch(() => {
					this.ngZone.run(() => {
						this.toast.error(
							'Could not read folder',
							'Very large files may exceed browser memory. Try Upload folder instead.',
						);
					});
				});
			return;
		}

		const hasFolders = relativePaths.some((p) => p.includes('/') || p.includes('\\'));
		if (hasFolders) {
			this.snapshotFolderFilesForPrompt(arr, relativePaths);
			return;
		}

		this.startUploadAfterChecks(id, arr, relativePaths.map(() => ''));
	}

	/** After drag snapshot (or input path logic): folder prompt vs direct upload. */
	private continueAfterSnapshot(id: string, snapshots: File[], relativePaths: string[]): void {
		const hasFolders = relativePaths.some((p) => p.includes('/') || p.includes('\\'));
		if (hasFolders) {
			this.pendingUploadFiles = snapshots;
			this.pendingRelativePaths = relativePaths;
			this.showFolderPrompt.set(true);
			return;
		}
		this.startUploadAfterChecks(id, snapshots, relativePaths.map(() => ''));
	}

	private startUploadAfterChecks(
		driveId: string,
		files: File[],
		relativePaths: string[],
	): void {
		const totalIncomingBytes = files.reduce((acc, file) => acc + file.size, 0);
		const freeSpace = this.getFreeSpaceBytes();
		if (totalIncomingBytes > freeSpace) {
			this.toast.error(
				'Not enough space',
				`These files require ${formatBytes(totalIncomingBytes)}, but only ${formatBytes(freeSpace)} is available.`,
				{ displayTime: 16000 },
			);
			return;
		}

		const need = this.indicesNeedingResolution(relativePaths, files);
		if (need.length === 0) {
			this.runUpload(driveId, files, relativePaths, { overwrite: false });
			return;
		}

		const sample = need
			.slice(0, 5)
			.map((i) => this.logicalPathForUpload(relativePaths[i] ?? '', files[i].name));
		const more = need.length > 5 ? `\n… and ${need.length - 5} more` : '';

		const ref = this.dialog.open<DialogUniversalComponent, UniversalDialogResult>(DialogUniversalComponent, {
			...defaultDialogConfig(),
			data: {
				title: 'File name conflict',
				message: `Some uploads match files already on this volume (or duplicate each other):\n\n${sample.join('\n')}${more}\n\nReplace overwrites existing files. Rename saves new uploads with names like “file (2).txt”.\n\nPress Escape or click outside to cancel.`,
				confirmLabel: 'Replace existing',
				cancelLabel: 'Rename new files',
				variant: 'warning',
				messageMinHeight: '140px',
			} satisfies UniversalDialogData,
		});
		ref.afterClosed().subscribe((r) => {
			if (r === undefined) return;
			if (r === true) {
				this.runUpload(driveId, files, relativePaths, { overwrite: true });
				return;
			}
			const { paths, fileNames } = this.resolveRenamedUploads(relativePaths, files, need);
			this.runUpload(driveId, files, paths, { overwrite: false, fileNames });
		});
	}
}

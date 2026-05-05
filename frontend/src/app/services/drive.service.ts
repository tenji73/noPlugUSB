import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpEvent } from '@angular/common/http';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

export interface Drive {
	id: string;
	filename: string;
	displayName: string;
	description: string;
	/** Total virtual disk capacity in bytes. */
	size: number;
	format: string;
	icon: string;
	themeColor: string;
	/** Bytes used on the virtual disk (demo / future live stats). */
	usedBytes?: number;
	/** Number of files on the volume (demo / future live stats). */
	fileCount?: number;
}

export interface SystemState {
	activeDriveId: string | null;
	lastConnectedAt: string | null;
	isPrinterIdle: boolean;
}

/** Global persisted state: hardware slot + drive catalog. */
export interface NoPlugState {
	systemState: SystemState;
	drives: Drive[];
}

/** Entry in a virtual drive volume (mock or live listing). */
export interface DriveFile {
	id: string;
	name: string;
	sizeBytes: number;
	dateModified: string;
	extension: string;
	/** POSIX-style path from volume root when uploaded with folder structure (optional). */
	relativePath?: string;
	/**
	 * `/api/thumbnails/{md5}.webp` when that file exists; hash is of `driveId/relativePathFromRoot`.
	 */
	thumbnailURL?: string;
}

export interface DriveUploadResponse {
	success: boolean;
	message?: string;
	filesReceived?: number;
	added?: number;
}

/** Result of moving a file or folder to another parent directory on the volume. */
export interface DriveMoveResult {
	kind: 'file' | 'folder';
	/** POSIX path from volume root after the move. */
	path: string;
}

@Injectable({
	providedIn: 'root',
})
export class DriveService {
	private http = inject(HttpClient);
	private drivesUrl = '/api/drives';
	private stateUrl = '/api/state';

	/** Last successful `/api/state` (instant dashboard paint when navigating back from file manager). */
	private lastFullState = signal<NoPlugState | null>(null);

	getDrives(): Observable<Drive[]> {
		return this.http.get<Drive[]>(this.drivesUrl);
	}

	getFullState(): Observable<NoPlugState> {
		return this.http.get<NoPlugState>(this.stateUrl).pipe(tap((s) => this.lastFullState.set(s)));
	}

	/** Snapshot for hydration before the next network round-trip (may be stale). */
	getLastFullStateSnapshot(): NoPlugState | null {
		return this.lastFullState();
	}

	createDrive(body: {
		displayName: string;
		description: string;
		/** Capacity in bytes. */
		size: number;
		format: string;
		icon: string;
		themeColor: string;
	}): Observable<Drive> {
		return this.http.post<Drive>(this.drivesUrl, body);
	}

	updateDrive(
		id: string,
		body: { displayName?: string; description?: string; size?: number; icon?: string },
	): Observable<Drive> {
		return this.http.put<Drive>(`${this.drivesUrl}/${encodeURIComponent(id)}`, body);
	}

	deleteDrive(id: string): Observable<NoPlugState> {
		return this.http.delete<NoPlugState>(`${this.drivesUrl}/${encodeURIComponent(id)}`);
	}

	getFiles(driveId: string): Observable<DriveFile[]> {
		return this.http.get<DriveFile[]>(
			`${this.drivesUrl}/${encodeURIComponent(driveId)}/files`,
		);
	}

	/** Fast aggregates for dashboard cards (matches file-manager byte sum + file count). */
	getDriveVolumeStats(driveId: string): Observable<{ fileCount: number; usedBytes: number }> {
		return this.http.get<{ fileCount: number; usedBytes: number }>(
			`${this.drivesUrl}/${encodeURIComponent(driveId)}/volume-stats`,
		);
	}

	/** Rebuild cached `.webp` thumbnails for every file on this drive (server clears cache then re-encodes). */
	regenerateThumbnails(driveId: string): Observable<{ ok: boolean; processed: number; errors: string[] }> {
		return this.http.post<{ ok: boolean; processed: number; errors: string[] }>(
			`${this.drivesUrl}/${encodeURIComponent(driveId)}/thumbnails/regenerate`,
			{},
		);
	}

	/** Create an empty folder; `relativePath` is POSIX from volume root (e.g. `Photos` or `Photos/2024`). */
	createDriveFolder(driveId: string, relativePath: string): Observable<{ path: string }> {
		return this.http.post<{ path: string }>(
			`${this.drivesUrl}/${encodeURIComponent(driveId)}/folders`,
			{ path: relativePath },
		);
	}

	/** Recursively delete a folder under the volume root. */
	deleteDriveFolder(driveId: string, relativePath: string) {
		return this.http.delete<void>(`${this.drivesUrl}/${encodeURIComponent(driveId)}/folders`, {
			body: { path: relativePath },
		});
	}

	/**
	 * Move a file (catalog entry) or folder (directory tree) under `targetParentPath`.
	 * Use `targetParentPath: ''` for the volume root.
	 */
	moveDriveItem(driveId: string, sourceLogicalPath: string, targetParentPath: string) {
		return this.http.post<DriveMoveResult>(`${this.drivesUrl}/${encodeURIComponent(driveId)}/move`, {
			sourceLogicalPath,
			targetParentPath,
		});
	}

	/**
	 * Multipart upload with upload progress events (suitable for large files; server streams to disk).
	 * `relativePaths` aligns with `files` by index (POSIX paths from volume root); use empty string for root.
	 * Paths and `overwrite` are sent before file parts so the server can resolve destinations per file.
	 * Optional `fileNames` sets the multipart filename per part (avoids copying large `File` blobs when renaming).
	 */
	uploadFiles(
		driveId: string,
		files: File[],
		relativePaths?: string[],
		options?: { overwrite?: boolean; fileNames?: string[] },
	): Observable<HttpEvent<DriveUploadResponse>> {
		const fd = new FormData();
		const overwrite = options?.overwrite === true;
		fd.append('overwrite', overwrite ? 'true' : 'false');
		const n = files.length;
		for (let i = 0; i < n; i++) {
			fd.append('paths', relativePaths?.[i] ?? '');
		}
		const names = options?.fileNames;
		for (let i = 0; i < n; i++) {
			const partName = names?.[i] ?? files[i].name;
			fd.append('files', files[i], partName);
		}
		return this.http.post<DriveUploadResponse>(
			`${this.drivesUrl}/${encodeURIComponent(driveId)}/upload`,
			fd,
			{
				observe: 'events',
				reportProgress: true,
			},
		);
	}

	deleteDriveFile(driveId: string, fileId: string) {
		return this.http.delete<void>(
			`${this.drivesUrl}/${encodeURIComponent(driveId)}/files/${encodeURIComponent(fileId)}`,
		);
	}

	renameDriveFile(driveId: string, fileId: string, name: string): Observable<DriveFile> {
		return this.http.patch<DriveFile>(
			`${this.drivesUrl}/${encodeURIComponent(driveId)}/files/${encodeURIComponent(fileId)}`,
			{ name },
		);
	}

	/** Binary body; trigger a browser download with {@link DriveFile.name}. */
	downloadDriveFile(driveId: string, fileId: string): Observable<Blob> {
		return this.http.get(
			`${this.drivesUrl}/${encodeURIComponent(driveId)}/files/${encodeURIComponent(fileId)}/download`,
			{ responseType: 'blob' },
		);
	}
}

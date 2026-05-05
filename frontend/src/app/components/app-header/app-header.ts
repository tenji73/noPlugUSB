import { Component, HostListener, inject, signal, ElementRef, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';
import { take } from 'rxjs/operators';
import { DriveService, NoPlugState } from '../../services/drive.service';
import { DriveStateNotifyService } from '../../services/drive-state-notify.service';
import { DialogService } from '../dialog/dialog.service';
import { defaultDialogConfig } from '../../dialog-ui';
import {
	DriveFormDialogComponent,
	DriveFormDialogData,
} from '../dialogs/drive-form-dialog.component';
import {
	DialogUniversalComponent,
	type UniversalDialogData,
	UniversalDialogResult,
} from '../dialog/dialog-universal.component';
import { ThemeService, ThemeId, THEME_OPTIONS } from '../../services/theme.service';
import { CachePurgeService } from '../../services/cache-purge.service';
import { ToastService } from '../toast/toast.service';

@Component({
	selector: 'app-header',
	standalone: true,
	imports: [RouterLink, CommonModule],
	templateUrl: './app-header.html',
})
export class AppHeaderComponent {
	private driveService = inject(DriveService);
	private dialog = inject(DialogService);
	private driveStateNotify = inject(DriveStateNotifyService);
	private themeService = inject(ThemeService);
	private cachePurge = inject(CachePurgeService);
	private toast = inject(ToastService);

	readonly settingsOpen = signal(false);
	readonly createMenuOpen = signal(false);
	readonly themes = THEME_OPTIONS;
	readonly themeId = this.themeService.themeId;

	private settingsRoot = viewChild<ElementRef<HTMLElement>>('settingsRoot');
	private createMenuRoot = viewChild<ElementRef<HTMLElement>>('createMenuRoot');
	private importInput = viewChild<HTMLInputElement>('importInput');

	openCreateDialog(): void {
		this.driveService
			.getFullState()
			.pipe(take(1))
			.subscribe({
				next: (s) => {
					const ref = this.dialog.open<DriveFormDialogComponent, NoPlugState | undefined>(
						DriveFormDialogComponent,
						{
							...defaultDialogConfig(),
							data: { mode: 'create', otherDrives: s.drives } satisfies DriveFormDialogData,
						},
					);
					ref.afterClosed().subscribe((state) => {
						if (state) {
							this.driveStateNotify.notify(state);
						}
					});
				},
				error: () => {},
			});
	}

	toggleSettings(ev: MouseEvent): void {
		ev.stopPropagation();
		this.settingsOpen.update((v) => !v);
	}

	toggleCreateMenu(ev: MouseEvent): void {
		ev.stopPropagation();
		this.createMenuOpen.update((v) => !v);
		// Avoid having two menus fight for the same click-outside logic.
		this.settingsOpen.set(false);
	}

	selectCreateNew(ev: MouseEvent): void {
		ev.stopPropagation();
		this.createMenuOpen.set(false);
		this.openCreateDialog();
	}

	selectImportExisting(ev: MouseEvent): void {
		ev.stopPropagation();
		this.createMenuOpen.set(false);
		this.importInput()?.click();
	}

	async onImportFilePicked(event: Event): Promise<void> {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;

		let text = '';
		try {
			text = await file.text();
		} catch {
			this.toast.error('Could not read file', 'Try again.');
			return;
		}

		let manifest: unknown;
		try {
			manifest = JSON.parse(text);
		} catch {
			this.toast.error('Invalid backup file', 'Expected JSON backup manifest.');
			return;
		}

		const drive = (manifest as any)?.drive as
			| {
					displayName?: string;
					description?: string;
					size?: number;
					format?: string;
					icon?: string;
					themeColor?: string;
				}
			| undefined;

		if (!drive?.displayName || typeof drive.size !== 'number') {
			this.toast.error('Invalid backup manifest', 'Missing drive metadata.');
			return;
		}

		const filesCount = Array.isArray((manifest as any)?.files) ? (manifest as any).files.length : 0;
		const ref = this.dialog.open<DialogUniversalComponent, UniversalDialogResult>(DialogUniversalComponent, {
			...defaultDialogConfig(),
			data: {
				title: 'Import this backup (demo)?',
				message:
					'This will create an empty virtual drive using the backup metadata. Restoring file contents will be implemented later on the Raspberry Pi.',
				confirmLabel: 'Import metadata',
				cancelLabel: 'Cancel',
				variant: 'warning',
			} satisfies UniversalDialogData,
		});

		ref.afterClosed().subscribe((confirmed) => {
			if (confirmed !== true) return;
			this.driveService
				.createDrive({
					displayName: String(drive.displayName),
					description: String(drive.description ?? ''),
					size: drive.size as number,
					format: String(drive.format ?? 'FAT32'),
					icon: String(drive.icon ?? '💾'),
					themeColor: String(drive.themeColor ?? 'blue'),
				})
				.pipe(take(1))
				.subscribe({
					next: (d) => {
						this.driveService.getFullState().pipe(take(1)).subscribe((s) => this.driveStateNotify.notify(s));
						this.toast.success('Drive imported', `Created "${d.displayName}"${filesCount ? ` (${filesCount} files listed)` : ''}.`);
					},
					error: (e: unknown) => {
						// Best-effort: DriveService errors follow the same { error?: string, code?: string } pattern.
						const msg = (e as any)?.error ?? 'Could not import drive.';
						this.toast.error('Could not import drive', msg);
					},
				});
		});
	}

	selectTheme(id: ThemeId, ev: MouseEvent): void {
		ev.stopPropagation();
		this.themeService.setTheme(id);
	}

	purgeCaches(ev: MouseEvent): void {
		ev.stopPropagation();
		const ref = this.dialog.open<DialogUniversalComponent, UniversalDialogResult>(DialogUniversalComponent, {
			...defaultDialogConfig(),
			data: {
				title: 'Purge all caches?',
				message:
					'This deletes generated thumbnail files on the server to free disk space. Thumbnails will be re-created when you browse files again.',
				confirmLabel: 'Purge caches',
				cancelLabel: 'Cancel',
				variant: 'warning',
			} satisfies UniversalDialogData,
		});
		ref.afterClosed().subscribe((confirmed) => {
			if (confirmed !== true) return;
			this.cachePurge.purgeAll().subscribe({
				next: (r) => {
					this.settingsOpen.set(false);
					if (r.success) {
						this.toast.success('Caches cleared', `Removed ${r.removed ?? 0} thumbnail file(s).`);
					} else {
						this.toast.error('Could not purge caches', r.error ?? 'Unknown error');
					}
				},
				error: () => {
					this.toast.error('Could not purge caches', 'Check that the API is reachable.');
				},
			});
		});
	}

	@HostListener('document:click', ['$event'])
	onDocumentClick(ev: MouseEvent): void {
		const target = ev.target as Node;

		// If click is inside settings menu, don't close it.
		if (this.settingsOpen()) {
			const root = this.settingsRoot()?.nativeElement;
			if (root?.contains(target)) return;
			this.settingsOpen.set(false);
		}

		// If click is inside create menu, don't close it.
		if (this.createMenuOpen()) {
			const root = this.createMenuRoot()?.nativeElement;
			if (root?.contains(target)) return;
			this.createMenuOpen.set(false);
		}
	}

	@HostListener('document:keydown', ['$event'])
	onKeydown(ev: KeyboardEvent): void {
		if (ev.key === 'Escape' && (this.settingsOpen() || this.createMenuOpen())) {
			this.settingsOpen.set(false);
			this.createMenuOpen.set(false);
		}
	}
}

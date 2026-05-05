import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { DIALOG_DATA } from '../dialog/dialog.tokens';
import { DialogRef } from '../dialog/dialog.types';
import { DriveService, Drive, NoPlugState } from '../../services/drive.service';
import { displayNameToBinFilename, normalizeDriveNameKey } from '../../utils/drive-filename';
import { bytesToGb, gbToBytes } from '../../utils/bytes';
import { DRIVE_CAPACITY_OPTIONS } from './drive-capacity-options';

export type DriveFormDialogData =
	| { mode: 'create'; otherDrives: Drive[] }
	| { mode: 'edit'; drive: Drive; otherDrives: Drive[] };

@Component({
	selector: 'app-drive-form-dialog',
	standalone: true,
	templateUrl: './drive-form-dialog.component.html',
	imports: [CommonModule, FormsModule],
})
export class DriveFormDialogComponent implements OnInit {
	private driveService = inject(DriveService);
	dialogRef = inject(DialogRef<NoPlugState | boolean | undefined>);
	data = inject<DriveFormDialogData>(DIALOG_DATA);

	readonly capacityOptions = DRIVE_CAPACITY_OPTIONS;

	form = {
		displayName: '',
		description: '',
		icon: '💾',
	};

	/** Only used when `mode === 'create'`. */
	createOnly = {
		format: 'FAT32' as 'FAT32' | 'exFAT',
		themeColor: 'blue' as 'blue' | 'emerald' | 'red' | 'purple',
	};

	/** Selected capacity in binary GiB (0.5 = 512 MiB). */
	selectedSizeGb = 8;

	busy = signal(false);
	error = signal<string | null>(null);

	get isCreate(): boolean {
		return this.data.mode === 'create';
	}

	get editDrive(): Drive | null {
		return this.data.mode === 'edit' ? this.data.drive : null;
	}

	ngOnInit(): void {
		if (this.data.mode === 'edit') {
			const d = this.data.drive;
			this.form = {
				displayName: d.displayName,
				description: d.description,
				icon: d.icon || '💾',
			};
			this.selectedSizeGb = this.pickClosestSizeGb(bytesToGb(d.size));
		} else {
			this.selectedSizeGb = 8;
		}
	}

	get otherDrives(): Drive[] {
		return this.data.otherDrives;
	}

	pickClosestSizeGb(gb: number): number {
		const opts = this.capacityOptions;
		return opts.reduce<number>(
			(best, o) => (Math.abs(o.gb - gb) < Math.abs(best - gb) ? o.gb : best),
			opts[0].gb,
		);
	}

	selectSizeGb(gb: number): void {
		if (this.busy()) return;
		this.selectedSizeGb = gb;
	}

	pillClass(gb: number): string {
		const selected = this.selectedSizeGb === gb;
		const base =
			'btn rounded-lg px-2.5 py-2 text-xs font-medium border transition-all disabled:opacity-50 disabled:pointer-events-none';
		if (selected) {
			return `${base} ring-2 ring-blue-500 border-blue-500/60 bg-app-raised text-white shadow-[0_0_0_1px_rgba(59,130,246,0.35)]`;
		}
		return `${base} border-app-border-soft bg-app-page/90 text-app-fg hover:bg-app-raised hover:border-app-muted`;
	}

	previewFilename(): string {
		return displayNameToBinFilename(this.form.displayName || 'drive');
	}

	private validateName(trimmed: string): string | null {
		if (!trimmed) {
			return 'Enter a name for the drive.';
		}
		const key = normalizeDriveNameKey(trimmed);
		const binName = displayNameToBinFilename(trimmed);
		for (const d of this.otherDrives) {
			if (normalizeDriveNameKey(d.displayName) === key) {
				return this.isCreate
					? 'A drive with this name already exists. Choose a unique name.'
					: 'A drive with this name already exists.';
			}
			if (d.filename === binName) {
				return this.isCreate
					? 'Another drive already uses this disk image filename. Pick a different name.'
					: 'Another drive would use this disk image filename.';
			}
		}
		return null;
	}

	onSubmit(): void {
		if (this.isCreate) {
			this.submitCreate();
		} else {
			this.submitEdit();
		}
	}

	private submitCreate(): void {
		if (this.busy()) return;
		const name = this.form.displayName.trim() || 'Untitled';
		const err = this.validateName(name);
		if (err) {
			this.error.set(err);
			return;
		}
		this.error.set(null);
		this.busy.set(true);
		this.driveService
			.createDrive({
				displayName: name,
				description: this.form.description,
				size: gbToBytes(this.selectedSizeGb),
				format: this.createOnly.format,
				icon: this.form.icon,
				themeColor: this.createOnly.themeColor,
			})
			.subscribe({
				next: () => {
					this.driveService.getFullState().subscribe({
						next: (s) => {
							this.busy.set(false);
							this.dialogRef.close(s);
						},
						error: () => {
							this.busy.set(false);
							this.dialogRef.close(undefined);
						},
					});
				},
				error: (e: HttpErrorResponse) => {
					this.busy.set(false);
					if (e.status === 0) {
						this.error.set(
							'Cannot reach the API (is the backend running?). Run: cd backend && npm start',
						);
						return;
					}
					if (e.status === 409) {
						const body = e.error as { error?: string } | null;
						this.error.set(body?.error ?? 'A drive with this name or image file already exists.');
						return;
					}
					this.error.set('Could not create drive. Try again.');
				},
			});
	}

	private submitEdit(): void {
		if (this.busy()) return;
		if (this.data.mode !== 'edit') return;
		const trimmed = this.form.displayName.trim();
		const err = this.validateName(trimmed);
		if (err) {
			this.error.set(err);
			return;
		}
		this.error.set(null);
		this.busy.set(true);
		const d = this.data.drive;
		this.driveService
			.updateDrive(d.id, {
				displayName: trimmed,
				description: this.form.description,
				size: gbToBytes(this.selectedSizeGb),
				icon: this.form.icon,
			})
			.subscribe({
				next: () => {
					this.busy.set(false);
					this.dialogRef.close(true);
				},
				error: (e: HttpErrorResponse) => {
					this.busy.set(false);
					if (e.status === 409) {
						const body = e.error as { error?: string } | null;
						this.error.set(body?.error ?? 'Name conflicts with another drive.');
						return;
					}
					if (e.status === 400) {
						const body = e.error as { error?: string } | null;
						this.error.set(body?.error ?? 'Invalid data.');
						return;
					}
					this.error.set('Could not save changes.');
				},
			});
	}

	cancel(): void {
		if (this.busy()) return;
		this.dialogRef.close(this.isCreate ? undefined : false);
	}
}

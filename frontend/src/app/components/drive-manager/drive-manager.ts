import { Component, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { finalize, switchMap, take } from 'rxjs/operators';
import { DriveService, Drive, NoPlugState, SystemState } from '../../services/drive.service';
import { DriveStateNotifyService } from '../../services/drive-state-notify.service';
import { UsbService } from '../../services/usb.service';
import { DialogService } from '../dialog/dialog.service';
import { defaultDialogConfig } from '../../dialog-ui';
import {
	DialogUniversalComponent,
	UniversalDialogData,
	UniversalDialogResult,
} from '../dialog/dialog-universal.component';
import {
	DriveFormDialogComponent,
	DriveFormDialogData,
} from '../dialogs/drive-form-dialog.component';
import { DriveCardComponent } from '../drive-card/drive-card.component';
import { ToastService } from '../toast/toast.service';
import { displayNameToBinFilename } from '../../utils/drive-filename';

@Component({
	selector: 'app-drive-manager',
	standalone: true,
	templateUrl: './drive-manager.html',
	imports: [CommonModule, DriveCardComponent],
	host: { class: 'flex min-h-0 min-w-0 flex-1 flex-col' },
})
export class DriveManagerComponent {
	private driveService = inject(DriveService);
	private usbService = inject(UsbService);
	private dialog = inject(DialogService);
	private router = inject(Router);
	private driveStateNotify = inject(DriveStateNotifyService);
	private toast = inject(ToastService);

	drives = input.required<Drive[]>();
	systemState = input.required<SystemState>();
	/** First load in flight and no cached catalog yet — show loading, not the “no devices” empty state. */
	catalogLoading = input(false);
	stateUpdated = output<NoPlugState>();

	/** USB connect/disconnect in flight — disables actions on every card. */
	usbBusy = signal(false);
	/** Card showing blur overlay (connect/disconnect/delete/edit refresh). */
	busyDriveId = signal<string | null>(null);
	busyLabel = signal('');

	openCreateDialog(): void {
		if (this.usbBusy() || this.busyDriveId()) return;
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
							this.stateUpdated.emit(state);
							this.driveStateNotify.notify(state);
						}
					});
				},
				error: () => {},
			});
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

	isDriveActive(drive: Drive): boolean {
		return this.systemState().activeDriveId === drive.id;
	}

	cardBusy(drive: Drive): boolean {
		return this.busyDriveId() === drive.id;
	}

	cardInterlocked(drive: Drive): boolean {
		return this.usbBusy() || this.cardBusy(drive);
	}

	private setCardBusy(driveId: string, label: string): void {
		this.busyDriveId.set(driveId);
		this.busyLabel.set(label);
	}

	private clearCardBusy(): void {
		this.busyDriveId.set(null);
		this.busyLabel.set('');
	}

	onConnect(drive: Drive): void {
		if (this.usbBusy() || this.busyDriveId()) return;

		const activeId = this.systemState().activeDriveId;
		if (activeId && activeId !== drive.id) {
			const activeDrive = this.drives().find((d) => d.id === activeId);
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
				next: (s) => this.stateUpdated.emit(s),
				error: () => {},
			});
	}

	requestDisconnect(): void {
		if (this.usbBusy() || this.busyDriveId()) return;
		const activeId = this.systemState().activeDriveId;
		if (!activeId) return;

		const ref = this.dialog.open<DialogUniversalComponent, UniversalDialogResult>(DialogUniversalComponent, {
			...defaultDialogConfig(),
			data: {
				title: 'Disconnect from device?',
				message:'Host Device Warning: Disconnecting the virtual drive while the host is actively accessing it (e.g., printing, playing media, or milling) may result in data loss or system errors. Proceed with disconnect?',
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
				next: (s) => this.stateUpdated.emit(s),
				error: () => {},
			});
	}

	openEditDrive(drive: Drive): void {
		if (this.usbBusy() || this.busyDriveId()) return;
		const ref = this.dialog.open<DriveFormDialogComponent, boolean>(DriveFormDialogComponent, {
			...defaultDialogConfig(),
			data: {
				mode: 'edit',
				drive,
				otherDrives: this.drives().filter((d) => d.id !== drive.id),
			} satisfies DriveFormDialogData,
		});
		ref.afterClosed().subscribe((saved) => {
			if (!saved) return;
			this.setCardBusy(drive.id, 'Updating…');
			this.driveService
				.getFullState()
				.pipe(finalize(() => this.clearCardBusy()))
				.subscribe({
					next: (s) => this.stateUpdated.emit(s),
					error: () => this.clearCardBusy(),
				});
		});
	}

	requestDelete(drive: Drive): void {
		if (this.usbBusy() || this.busyDriveId()) return;
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
					next: (s) => this.stateUpdated.emit(s),
					error: () => {},
				});
		});
	}

	manageFiles(drive: Drive): void {
		if (this.cardInterlocked(drive) || this.isDriveActive(drive)) return;
		void this.router.navigate(['/files', drive.id]);
	}
}

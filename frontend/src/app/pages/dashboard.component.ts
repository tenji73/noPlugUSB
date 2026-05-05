import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { Drive, DriveService, NoPlugState, SystemState } from '../services/drive.service';
import { DriveStateNotifyService } from '../services/drive-state-notify.service';
import { DriveManagerComponent } from '../components/drive-manager/drive-manager';

@Component({
	selector: 'app-dashboard',
	standalone: true,
	templateUrl: './dashboard.component.html',
	imports: [CommonModule, DriveManagerComponent],
	host: { class: 'flex min-h-0 flex-1 flex-col' },
})
export class DashboardComponent implements OnInit {
	private driveService = inject(DriveService);
	private driveStateNotify = inject(DriveStateNotifyService);
	private destroyRef = inject(DestroyRef);

	drives = signal<Drive[]>([]);
	systemState = signal<SystemState>({
		activeDriveId: null,
		lastConnectedAt: null,
		isPrinterIdle: true,
	});

	/** True until first successful paint from cache or `/api/state` (avoids empty-state flash while loading). */
	catalogLoading = signal(true);

	ngOnInit(): void {
		const cached = this.driveService.getLastFullStateSnapshot();
		if (cached) {
			this.applyState(cached);
		}
		this.loadFullState();
		this.driveStateNotify.state$
			.pipe(takeUntilDestroyed(this.destroyRef))
			.subscribe((s) => this.applyState(s));
	}

	loadFullState(): void {
		this.driveService.getFullState().subscribe({
			next: (s) => this.applyState(s),
			error: () => this.catalogLoading.set(false),
		});
	}

	applyState(s: NoPlugState): void {
		this.drives.set(s.drives);
		this.systemState.set(s.systemState);
		this.catalogLoading.set(false);
	}
}

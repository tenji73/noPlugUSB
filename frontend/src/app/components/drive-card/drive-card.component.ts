import { Component, computed, HostBinding, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Drive } from '../../services/drive.service';
import { driveRemainingBytes, formatBytes } from '../../utils/bytes';
import { BusyOverlayComponent } from '../busy-overlay/busy-overlay.component';

export type DriveCardVariant = 'dashboard' | 'sidebar';

/**
 * Shared USB / virtual drive card: badges, storage meter, and actions.
 * - **dashboard**: fills the grid cell (`h-full`) with a flex spacer so cards in a row match height.
 * - **sidebar**: natural height only (no stretching).
 */
@Component({
	selector: 'app-drive-card',
	standalone: true,
	imports: [CommonModule, BusyOverlayComponent],
	templateUrl: './drive-card.component.html',
	host: { class: 'block' },
})
export class DriveCardComponent {
	drive = input.required<Drive>();

	/** Layout context: dashboard grid vs file-manager sidebar. */
	variant = input<DriveCardVariant>('dashboard');

	@HostBinding('class.h-full')
	get hostFullHeight(): boolean {
		return this.variant() === 'dashboard';
	}

	@HostBinding('class.min-h-0')
	get hostMinHeightZero(): boolean {
		return this.variant() === 'dashboard';
	}

	@HostBinding('class.self-start')
	get hostSelfStart(): boolean {
		return this.variant() === 'sidebar';
	}

	@HostBinding('class.w-full')
	get hostFullWidth(): boolean {
		return this.variant() === 'sidebar';
	}

	/** When set (e.g. live file-list total in file manager), overrides {@link Drive.usedBytes} for the meter. */
	usedBytesOverride = input<number | null>(null);

	/** This drive is exposed to the host as USB storage. */
	isUsbActive = input(false);

	cardBusy = input(false);
	interlocked = input(false);
	busyLabel = input('');

	connect = output<void>();
	disconnect = output<void>();
	edit = output<void>();
	delete = output<void>();
	manageFiles = output<void>();
	backup = output<void>();

	effectiveUsedBytes = computed(() => {
		const d = this.drive();
		const o = this.usedBytesOverride();
		if (o != null) return Math.max(0, o);
		return d.usedBytes ?? 0;
	});

	usagePercent = computed(() => {
		const d = this.drive();
		const sz = d.size;
		if (!sz) return 0;
		return Math.min(100, Math.round((100 * this.effectiveUsedBytes()) / sz));
	});

	capacityLabel(): string {
		return formatBytes(this.drive().size);
	}

	freeBytesLabel(): string {
		const d = this.drive();
		return formatBytes(driveRemainingBytes(d.size, this.effectiveUsedBytes()));
	}

	bytesUsedLabel(): string {
		return formatBytes(this.effectiveUsedBytes());
	}

	fileCountLabel(): number {
		return this.drive().fileCount ?? 0;
	}

	cardBorderClass(theme: string, active: boolean): string {
		if (active) {
			return 'border-emerald-500/60 shadow-emerald-500/20 ring-2 ring-emerald-500/80 ring-offset-2 ring-offset-app-page';
		}
		const map: Record<string, string> = {
			blue: 'border-blue-500/40 shadow-blue-500/10',
			emerald: 'border-emerald-500/40 shadow-emerald-500/10',
			red: 'border-red-500/40 shadow-red-500/10',
			purple: 'border-purple-500/40 shadow-purple-500/10',
		};
		return map[theme] ?? map['blue'];
	}

	iconBgClass(theme: string): string {
		const map: Record<string, string> = {
			blue: 'bg-blue-500/15 border-blue-500/25 text-blue-800 dim:text-blue-300',
			emerald: 'bg-emerald-500/15 border-emerald-500/25 text-emerald-800 dim:text-emerald-300',
			red: 'bg-red-500/15 border-red-500/25 text-red-800 dim:text-red-300',
			purple: 'bg-purple-500/15 border-purple-500/25 text-purple-800 dim:text-purple-300',
		};
		return map[theme] ?? map['blue'];
	}
}

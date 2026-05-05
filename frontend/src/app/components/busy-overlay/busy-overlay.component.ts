import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';

/** Full-bleed overlay with blur + spinner; place inside a `relative` container. */
@Component({
	selector: 'app-busy-overlay',
	standalone: true,
	imports: [CommonModule],
	template: `
		@if (active()) {
			<div
				class="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 rounded-[inherit] bg-app-page/70 backdrop-blur-md border border-white/5 pointer-events-auto"
				role="status"
				[attr.aria-busy]="true"
				[attr.aria-label]="label() || 'Loading'">
				<svg
					class="h-8 w-8 animate-spin text-blue-400"
					xmlns="http://www.w3.org/2000/svg"
					fill="none"
					viewBox="0 0 24 24"
					aria-hidden="true">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
					<path
						class="opacity-75"
						fill="currentColor"
						d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
				</svg>
				@if (label()) {
					<span class="text-xs font-medium text-app-fg px-2 text-center">{{ label() }}</span>
				}
			</div>
		}
	`,
})
export class BusyOverlayComponent {
	/** When true, covers the parent and blocks interaction below. */
	active = input(false);
	/** Optional short status (e.g. “Deleting…”). */
	label = input('');
}

import type { DialogConfig } from './components/dialog/dialog.types';

/**
 * Default options for `DialogService.open(Component, { ... })` — same idea as MatDialog:
 * backdrop, scrollable body, disableClose, then pass `data: { title, ... }` for the content.
 *
 * @example
 * ```ts
 * const ref = this.dialog.open(DialogUniversalComponent, {
 *   ...defaultDialogConfig(),
 *   data: { title: 'Are you sure?', message: '...', confirmLabel: 'OK' } satisfies UniversalDialogData,
 * });
 * ref.afterClosed().subscribe(() => { ... });
 * ```
 */
export function defaultDialogConfig(): Partial<DialogConfig> {
	return {
		backdrop: { opacity: 90, blur: 20 },
		scrollable: true,
		disableClose: false,
		width: 'min(100%, 28rem)',
		maxWidth: '95vw',
		panelClass: [
			'!bg-app-surface',
			'!text-app-fg',
			'border',
			'border-app-border-soft',
			'rounded-2xl',
			'shadow-2xl',
		],
	};
}

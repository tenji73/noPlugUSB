import { Observable, Subject } from 'rxjs';

/** Backdrop appearance when opening a dialog. */
export interface DialogBackdropConfig {
	/** 0–100, converted to opacity (e.g. 80 → 0.8). */
	opacity?: number;
	/** Blur in pixels (e.g. 3). */
	blur?: number;
}

/** Config passed to DialogService.open() – similar to MatDialogConfig. */
export interface DialogConfig<TData = unknown> {
	/** Data to inject into the dialog component (inject via DIALOG_DATA token). */
	data?: TData;
	/** Panel width (e.g. '500px', '90vw'). */
	width?: string;
	/** Max panel width. */
	maxWidth?: string;
	/** Panel height. */
	height?: string;
	/** Max panel height. */
	maxHeight?: string;
	/** Whether the panel content area is scrollable. */
	scrollable?: boolean;
	/** If true, escape and backdrop click do not close the dialog. */
	disableClose?: boolean;
	/** Backdrop opacity and blur. */
	backdrop?: DialogBackdropConfig;
	/** Extra CSS classes for the panel. */
	panelClass?: string | string[];
	/** Extra CSS classes for the backdrop. */
	backdropClass?: string | string[];
}

/**
 * Reference to an open dialog. Injected into the dialog content component so it can close itself.
 * Use close(result) to close with optional result; opener uses afterClosed() to observe the result.
 */
export class DialogRef<TResult = unknown> {
	private readonly _afterClosed = new Subject<TResult | undefined>();

	constructor(private readonly _closeFn: (result?: TResult) => void) {}

	/**
	 * Close the dialog, optionally with a result for the opener (via afterClosed()).
	 * @param result – Value to pass back to the caller (e.g. `{ confirmed: true }` or form data).
	 */
	close(result?: TResult): void {
		this._closeFn(result);
	}

	/**
	 * Observable that emits once when the dialog has closed, then completes.
	 * @returns Observable that emits the result passed to close(), or undefined if closed without result.
	 */
	afterClosed(): Observable<TResult | undefined> {
		return this._afterClosed.asObservable();
	}

	/** Called by the container when it has finished closing. */
	_notifyClosed(result?: TResult): void {
		this._afterClosed.next(result);
		this._afterClosed.complete();
	}
}

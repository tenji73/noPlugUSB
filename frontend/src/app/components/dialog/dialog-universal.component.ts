import {
	AfterViewInit,
	Component,
	ElementRef,
	HostListener,
	inject,
	OnInit,
	ViewChild,
} from '@angular/core';
import { CommonModule, NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DIALOG_DATA } from './dialog.tokens';
import { DialogRef } from './dialog.types';

/**
 * Data for {@link DialogUniversalComponent}. Pass via `DialogService.open(..., { data })`.
 * Unset fields use defaults (same idea as legacy MatDialog wrapper).
 */
export interface UniversalDialogData {
	title?: string;
	message?: string;
	/** Primary action label (default: `OK`). */
	confirmLabel?: string;
	cancelLabel?: string;
	hideConfirm?: boolean;
	hideCancel?: boolean;
	showPrompt?: boolean;
	/** Initial value when `showPrompt` is true. */
	prompt?: string;
	promptPlaceholder?: string;
	variant?: 'danger' | 'warning' | 'default';
	/** CSS min-height for the message block (default `80px`). */
	messageMinHeight?: string;
	/** Highlight strip above the message (same visual language as the “volume connected” callout). */
	noticeBanner?: { tone: 'amber' | 'red'; body: string };
}

/**
 * - `true` — user confirmed (no prompt).
 * - `string` — user confirmed with prompt (`showPrompt`).
 * - `false` — user clicked cancel.
 * - `undefined` — backdrop click or escape (if allowed).
 */
export type UniversalDialogResult = true | string | false | undefined;

@Component({
	selector: 'app-dialog-universal',
	standalone: true,
	imports: [CommonModule, NgClass, FormsModule],
	templateUrl: './dialog-universal.component.html',
})
export class DialogUniversalComponent implements OnInit, AfterViewInit {
	dialogRef = inject(DialogRef<UniversalDialogResult>);
	private raw = inject<UniversalDialogData>(DIALOG_DATA);

	@ViewChild('confirmBtn') private confirmBtn?: ElementRef<HTMLButtonElement>;

	/** Merged view model (legacy MatDialog-style defaults). */
	confirm!: {
		title: string;
		message: string;
		confirmLabel: string;
		cancelLabel: string;
		hideConfirm: boolean;
		hideCancel: boolean;
		showPrompt: boolean;
		promptPlaceholder: string;
		variant: 'danger' | 'warning' | 'default';
	};

	promptModel = '';
	messageMinHeight = '80px';
	noticeBanner: { tone: 'amber' | 'red'; body: string } | null = null;

	ngOnInit(): void {
		const d = this.raw;
		this.messageMinHeight = d.messageMinHeight ?? '80px';
		this.noticeBanner = d.noticeBanner ?? null;
		this.confirm = {
			title: d.title ?? 'Please confirm',
			message: d.message ?? '',
			confirmLabel: d.confirmLabel ?? 'OK',
			cancelLabel: d.cancelLabel ?? 'Cancel',
			hideConfirm: d.hideConfirm ?? false,
			hideCancel: d.hideCancel ?? false,
			showPrompt: d.showPrompt ?? false,
			promptPlaceholder: d.promptPlaceholder ?? '',
			variant: d.variant ?? 'default',
		};
		this.promptModel = d.prompt ?? '';
	}

	ngAfterViewInit(): void {
		/** `autofocus` is unreliable on dynamically inserted dialogs; focus primary for keyboard (Enter) support. */
		if (this.confirm.hideConfirm || this.confirm.showPrompt) return;
		queueMicrotask(() => this.confirmBtn?.nativeElement?.focus());
	}

	get primaryButtonClass(): string {
		const base = 'btn rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors';
		const v = this.confirm.variant;
		if (v === 'danger') {
			return `${base} bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-900/30`;
		}
		if (v === 'warning') {
			return `${base} bg-amber-600 hover:bg-amber-500 text-white shadow-lg shadow-amber-900/30`;
		}
		return `${base} bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/30`;
	}

	onConfirm(): void {
		if (this.confirm.showPrompt) {
			this.dialogRef.close(this.promptModel);
		} else {
			this.dialogRef.close(true);
		}
	}

	onCancel(): void {
		this.dialogRef.close(false);
	}

	/**
	 * Enter: primary action, except on cancel (or textarea).
	 * We must not rely on the browser’s default for `type="button"` — it often does not fire when the dialog is portaled.
	 */
	@HostListener('document:keydown', ['$event'])
	onDocumentKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter' || event.repeat) return;
		const t = event.target as HTMLElement | null;
		if (t?.tagName === 'TEXTAREA') return;

		if (t?.tagName === 'INPUT' && this.confirm.showPrompt) {
			event.preventDefault();
			this.onConfirm();
			return;
		}

		if (t?.closest('[data-dialog-action="cancel"]')) {
			event.preventDefault();
			this.onCancel();
			return;
		}
		if (t?.closest('[data-dialog-action="confirm"]')) {
			event.preventDefault();
			this.onConfirm();
			return;
		}

		event.preventDefault();
		this.onConfirm();
	}
}

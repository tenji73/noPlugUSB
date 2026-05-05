import { ChangeDetectorRef, Component, DestroyRef, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { trigger, transition, style, animate } from '@angular/animations';
import { ToastMessage, ToastService, ToastTone } from './toast.service';

@Component({
	selector: 'app-toast',
	standalone: true,
	imports: [CommonModule],
	templateUrl: './toast.component.html',
	animations: [
		trigger('fadeInOut', [
			transition(':enter', [
				style({ opacity: 0, transform: 'translateY(-20px)' }),
				animate(
					'200ms ease-out',
					style({ opacity: 1, transform: 'translateY(0)' }),
				),
			]),
			transition(':leave', [
				animate(
					'200ms ease-in',
					style({ opacity: 0, transform: 'translateY(-16px)' }),
				),
			]),
		]),
	],
})
export class ToastComponent {
	private toastService = inject(ToastService);
	private cdr = inject(ChangeDetectorRef);
	private destroyRef = inject(DestroyRef);

	messageList: ToastMessage[] = [];
	private readonly defaultDisplayTime = 4500;
	private timers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor() {
		this.toastService
			.messages$()
			.pipe(takeUntilDestroyed(this.destroyRef))
			.subscribe((m) => this.handleMessage(m));
	}

	panelClass(tone: ToastTone | undefined): string {
		switch (tone) {
			case 'success':
				return 'border-emerald-500/45 bg-emerald-950/95 text-emerald-50 shadow-[0_12px_40px_-8px_rgba(16,185,129,0.35)]';
			case 'error':
				return 'border-red-500/45 bg-red-950/95 text-red-50 shadow-[0_12px_40px_-8px_rgba(248,113,113,0.35)]';
			case 'warning':
				return 'border-amber-500/45 bg-amber-950/95 text-amber-50 shadow-[0_12px_40px_-8px_rgba(251,191,36,0.3)]';
			default:
				return 'border-app-border bg-app-surface/95 text-app-fg shadow-[0_12px_40px_-8px_rgba(0,0,0,0.55)]';
		}
	}

	textMutedClass(tone: ToastTone | undefined): string {
		switch (tone) {
			case 'success':
				return 'text-emerald-200/90';
			case 'error':
				return 'text-red-200/90';
			case 'warning':
				return 'text-amber-200/90';
			default:
				return 'text-app-muted';
		}
	}

	dismiss(id: string): void {
		const t = this.timers.get(id);
		if (t) {
			clearTimeout(t);
			this.timers.delete(id);
		}
		const i = this.messageList.findIndex((m) => m.id === id);
		if (i > -1) {
			this.messageList.splice(i, 1);
			this.cdr.markForCheck();
		}
	}

	private handleMessage(message: ToastMessage): void {
		const displayType = message.displayType ?? 'list';
		const position = message.position ?? 'top';

		if (displayType === 'overwrite') {
			const samePos = this.messageList.filter((m) => (m.position ?? 'top') === position);
			if (samePos.length > 0) {
				const target = samePos[samePos.length - 1];
				const existingTimer = this.timers.get(target.id);
				if (existingTimer) {
					clearTimeout(existingTimer);
					this.timers.delete(target.id);
				}
				target.title = message.title;
				target.content = message.content;
				target.icon = message.icon;
				target.tone = message.tone;
				target.displayTime = message.displayTime;
				target.position = position;
				this.startTimer(target);
				this.cdr.markForCheck();
				return;
			}
		}

		this.messageList.push(message);
		this.cdr.markForCheck();
		this.startTimer(message);
	}

	private startTimer(message: ToastMessage): void {
		const existing = this.timers.get(message.id);
		if (existing) {
			clearTimeout(existing);
		}
		const ms =
			message.displayTime !== undefined
				? message.displayTime
				: this.defaultDisplayTime;
		if (ms <= 0) {
			return;
		}
		const timer = setTimeout(() => this.dismiss(message.id), ms);
		this.timers.set(message.id, timer);
	}
}

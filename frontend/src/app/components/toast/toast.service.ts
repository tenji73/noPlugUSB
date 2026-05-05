import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

export type ToastTone = 'success' | 'error' | 'info' | 'warning';

export type ToastDisplayType = 'list' | 'overwrite';

export type ToastPosition = 'top' | 'bottom';

export interface ToastMessage {
	id: string;
	title: string;
	content?: string;
	icon?: string;
	tone?: ToastTone;
	/** ms; `0` = no auto-dismiss (still closable with ✕). Default by tone. */
	displayTime?: number;
	displayType?: ToastDisplayType;
	position?: ToastPosition;
}

function nextId(): string {
	return `toast_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

function defaultIcon(tone: ToastTone): string {
	switch (tone) {
		case 'success':
			return 'fa-solid fa-circle-check';
		case 'error':
			return 'fa-solid fa-circle-xmark';
		case 'warning':
			return 'fa-solid fa-triangle-exclamation';
		default:
			return 'fa-solid fa-circle-info';
	}
}

function defaultDisplayMs(tone: ToastTone): number {
	switch (tone) {
		case 'error':
			return 7000;
		case 'warning':
			return 6000;
		default:
			return 4500;
	}
}

@Injectable({ providedIn: 'root' })
export class ToastService {
	private subject = new Subject<ToastMessage>();

	/** Full control (overwrite mode, custom position, etc.). */
	show(partial: Omit<ToastMessage, 'id'> & { id?: string }): void {
		const tone = partial.tone ?? 'info';
		const id = partial.id ?? nextId();
		const displayTime =
			partial.displayTime !== undefined
				? partial.displayTime
				: defaultDisplayMs(tone);
		const merged: ToastMessage = {
			...partial,
			id,
			tone,
			icon: partial.icon ?? defaultIcon(tone),
			displayTime,
			position: partial.position ?? 'top',
			displayType: partial.displayType ?? 'list',
		};
		this.subject.next(merged);
	}

	success(title: string, content?: string, opts?: Partial<Omit<ToastMessage, 'id' | 'title'>>): void {
		this.show({ title, content, tone: 'success', ...opts });
	}

	error(title: string, content?: string, opts?: Partial<Omit<ToastMessage, 'id' | 'title'>>): void {
		this.show({ title, content, tone: 'error', ...opts });
	}

	warning(title: string, content?: string, opts?: Partial<Omit<ToastMessage, 'id' | 'title'>>): void {
		this.show({ title, content, tone: 'warning', ...opts });
	}

	info(title: string, content?: string, opts?: Partial<Omit<ToastMessage, 'id' | 'title'>>): void {
		this.show({ title, content, tone: 'info', ...opts });
	}

	messages$(): Observable<ToastMessage> {
		return this.subject.asObservable();
	}
}

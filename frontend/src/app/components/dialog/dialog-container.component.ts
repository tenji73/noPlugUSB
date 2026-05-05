import {
	Component,
	HostListener,
	Injector,
	Input,
	OnDestroy,
	OnInit,
	Type,
} from '@angular/core';
import { NgClass, NgComponentOutlet, NgStyle } from '@angular/common';
import type { DialogConfig, DialogRef } from './dialog.types';

@Component({
	selector: 'app-dialog-container',
	standalone: true,
	imports: [NgClass, NgStyle, NgComponentOutlet],
	template: `
		<div
			class="fixed inset-0 z-[9998] flex items-center justify-center p-4"
			[ngClass]="backdropClassList"
			[ngStyle]="backdropStyle"
			(click)="onBackdropClick($event)"
			role="dialog"
			aria-modal="true"
		>
			<div
				class="dialog-panel bg-white rounded-xl shadow-2xl relative flex flex-col overflow-hidden"
				[ngClass]="panelClassList"
				[ngStyle]="panelStyle"
				(click)="$event.stopPropagation()"
			>
				<div
					class="flex-1 min-h-0"
					[class.overflow-auto]="config.scrollable"
				>
					<ng-container
						*ngComponentOutlet="childComponent; injector: childInjector"
					></ng-container>
				</div>
			</div>
		</div>
	`,
})
export class DialogContainerComponent implements OnInit, OnDestroy {
	@Input() config!: DialogConfig;
	@Input() dialogRef!: DialogRef<any>;
	@Input() childComponent!: Type<unknown>;
	@Input() childInjector!: Injector;

	private previousBodyOverflow = '';

	ngOnInit(): void {
		if (typeof document !== 'undefined' && document.body) {
			this.previousBodyOverflow = document.body.style.overflow;
			document.body.style.overflow = 'hidden';
		}
	}

	ngOnDestroy(): void {
		if (typeof document !== 'undefined' && document.body) {
			document.body.style.overflow = this.previousBodyOverflow;
		}
	}

	get backdropStyle(): Record<string, string> {
		const { opacity = 80, blur = 0 } = this.config?.backdrop ?? {};
		return {
			'background-color': `rgba(0, 0, 0, ${opacity / 100})`,
			'backdrop-filter': blur ? `blur(${blur}px)` : 'none',
		};
	}

	get panelStyle(): Record<string, string> {
		const c = this.config ?? {};
		return {
			...(c.width && { width: c.width }),
			...(c.maxWidth && { 'max-width': c.maxWidth }),
			...(c.height && { height: c.height }),
			...(c.maxHeight && { 'max-height': c.maxHeight }),
		};
	}

	get panelClassList(): string[] {
		const base = ['max-w-[90vw]', 'max-h-[90vh]'];
		const extra = this.normalizeClass(this.config?.panelClass);
		return extra.length ? [...base, ...extra] : base;
	}

	get backdropClassList(): string[] {
		return this.normalizeClass(this.config?.backdropClass) ?? [];
	}

	@HostListener('document:keydown.escape')
	onEscape(): void {
		if (!this.config?.disableClose) {
			this.dialogRef.close();
		}
	}

	onBackdropClick(_event: MouseEvent): void {
		if (!this.config?.disableClose) {
			this.dialogRef.close();
		}
	}

	private normalizeClass(v?: string | string[]): string[] {
		if (v == null) return [];
		return Array.isArray(v) ? v : [v];
	}
}

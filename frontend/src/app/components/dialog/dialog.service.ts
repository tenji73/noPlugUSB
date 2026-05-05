import {
	ApplicationRef,
	ComponentRef,
	createComponent,
	EnvironmentInjector,
	Injector,
	Injectable,
	Type,
} from '@angular/core';
import { DialogConfig, DialogRef } from './dialog.types';
import { DialogContainerComponent } from './dialog-container.component';
import { DIALOG_DATA } from './dialog.tokens';

/**
 * Service to open dialogs with any component, similar to MatDialog.
 * Pass a component class and config; get a DialogRef to listen for results.
 */
@Injectable({ providedIn: 'root' })
export class DialogService {
	constructor(
		private readonly appRef: ApplicationRef,
		private readonly envInjector: EnvironmentInjector,
	) {}

	/**
	 * Opens a dialog that renders the given component. The component can inject `DialogRef` to close itself with a result, and `DIALOG_DATA` to read config.data.
	 * @param component – The Angular component to render inside the dialog (e.g. MyDialogComponent).
	 * @param config – Optional: width, maxWidth, height, maxHeight, scrollable, disableClose, backdrop, data, panelClass, backdropClass.
	 * @returns DialogRef – Call `afterClosed()` to subscribe to the result; the dialog content calls `this.dialogRef.close(result)` to close and pass data.
	 */
	open<TComponent, TResult = unknown, TData = unknown>(
		component: Type<TComponent>,
		config: DialogConfig<TData> = {},
	): DialogRef<TResult> {
		let containerRef: ComponentRef<DialogContainerComponent> | null = null;

		/** Default: allow closing via escape/backdrop; override with disableClose: true to prevent. */
		const resolvedConfig: DialogConfig<TData> = { disableClose: false, ...config };

		const dialogRef = new DialogRef<TResult>((result?: TResult) => {
			dialogRef._notifyClosed(result);
			if (containerRef) {
				const hostEl = containerRef.location.nativeElement as HTMLElement;
				hostEl.parentNode?.removeChild(hostEl);
				this.appRef.detachView(containerRef.hostView);
				containerRef.destroy();
				containerRef = null;
			}
		});

		const injector = Injector.create({
			providers: [
				{ provide: DialogRef, useValue: dialogRef },
				{ provide: DIALOG_DATA, useValue: resolvedConfig.data },
			],
			parent: this.envInjector,
		});

		containerRef = createComponent(DialogContainerComponent, {
			environmentInjector: this.envInjector,
			elementInjector: injector,
		});

		containerRef.instance.config = resolvedConfig;
		containerRef.instance.dialogRef = dialogRef;
		containerRef.instance.childComponent = component as Type<unknown>;
		containerRef.instance.childInjector = injector;

		this.appRef.attachView(containerRef.hostView);
		const hostEl = containerRef.location.nativeElement as HTMLElement;
		document.body.appendChild(hostEl);

		return dialogRef;
	}
}

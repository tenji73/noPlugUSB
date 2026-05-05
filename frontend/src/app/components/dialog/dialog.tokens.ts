import { InjectionToken } from '@angular/core';

/** Inject this token in a dialog component to receive the data passed in DialogConfig.data. */
export const DIALOG_DATA = new InjectionToken<unknown>('DIALOG_DATA');

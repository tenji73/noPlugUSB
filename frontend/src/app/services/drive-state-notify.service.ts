import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import type { NoPlugState } from './drive.service';

/**
 * Broadcasts full app state after drive catalog changes from contexts outside {@link DriveManagerComponent}
 * (e.g. creating a drive from the global header).
 */
@Injectable({ providedIn: 'root' })
export class DriveStateNotifyService {
	private readonly subject = new Subject<NoPlugState>();

	readonly state$ = this.subject.asObservable();

	notify(state: NoPlugState): void {
		this.subject.next(state);
	}
}

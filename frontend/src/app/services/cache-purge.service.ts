import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface CachePurgeResult {
	success: boolean;
	removed?: number;
	error?: string;
}

@Injectable({ providedIn: 'root' })
export class CachePurgeService {
	private http = inject(HttpClient);

	purgeAll(): Observable<CachePurgeResult> {
		return this.http.post<CachePurgeResult>('/api/cache/purge', {});
	}
}

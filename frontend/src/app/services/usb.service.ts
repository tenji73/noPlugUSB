import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { SystemState } from './drive.service';

export interface UsbActionResponse {
	success: boolean;
	message: string;
	systemState?: SystemState;
}

@Injectable({
	providedIn: 'root',
})
export class UsbService {
	private http = inject(HttpClient);
	private apiUrl = '/api/usb';

	disconnectPrinter() {
		return this.http.post<UsbActionResponse>(`${this.apiUrl}/disconnect`, {});
	}

	connectPrinter(driveId: string) {
		return this.http.post<UsbActionResponse>(`${this.apiUrl}/connect`, { driveId });
	}
}

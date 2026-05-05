import { Injectable, NgZone, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { environment } from '../../environments/environment';

export interface ThumbnailReadyPayload {
	type: 'thumbnailReady';
	driveId: string;
	storagePath: string;
	thumbnailURL: string;
}

/**
 * Subscribes to the backend WebSocket and emits when a volume thumbnail file is ready
 * (new generation or moved cache after rename/move).
 */
@Injectable({ providedIn: 'root' })
export class ThumbnailEventsService {
	private ngZone = inject(NgZone);
	/** Subscribe in components; completes when the app tears down (root service lives for app lifetime). */
	readonly thumbnailReady$ = new Subject<ThumbnailReadyPayload>();

	private ws: WebSocket | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	/** Connection attempts (initial + reconnects); reset on successful `open`. */
	private connectAttemptCount = 0;
	private readonly maxConnectAttempts = 3;

	constructor() {
		if (this.shouldUseThumbnailWebSocket()) {
			this.connect();
		}
	}

	/** Production builds skip WS; optional dev flag for broken proxy/tunnel. */
	private shouldUseThumbnailWebSocket(): boolean {
		if (environment.production) {
			return false;
		}
		if (environment.disableThumbnailWebSocket) {
			return false;
		}
		return true;
	}

	private wsUrl(): string {
		if (typeof window === 'undefined') return '';
		const { protocol, hostname, port } = window.location;
		const wsProto = protocol === 'https:' ? 'wss:' : 'ws:';
		// Angular dev server (:4200) proxies HTTP /api only; WS goes straight to the API port.
		const hostPort = port === '4200' ? `${hostname}:3000` : port ? `${hostname}:${port}` : hostname;
		return `${wsProto}//${hostPort}`;
	}

	private connect(): void {
		if (!this.shouldUseThumbnailWebSocket()) {
			return;
		}
		if (this.connectAttemptCount >= this.maxConnectAttempts) {
			return;
		}

		const url = this.wsUrl();
		if (!url) return;

		this.connectAttemptCount++;
		if (this.ws) {
			this.ws.onclose = null;
			this.ws.close();
			this.ws = null;
		}
		try {
			const socket = new WebSocket(url);
			this.ws = socket;
			socket.onopen = () => {
				this.connectAttemptCount = 0;
			};
			socket.onmessage = (event: MessageEvent<string>) => {
				try {
					const data = JSON.parse(event.data) as ThumbnailReadyPayload;
					if (
						data?.type === 'thumbnailReady' &&
						data.driveId &&
						data.storagePath &&
						data.thumbnailURL
					) {
						this.ngZone.run(() => this.thumbnailReady$.next(data));
					}
				} catch {
					/* ignore malformed */
				}
			};
			socket.onclose = () => {
				this.ws = null;
				this.scheduleReconnect();
			};
			socket.onerror = () => {
				socket.close();
			};
		} catch {
			this.scheduleReconnect();
		}
	}

	private scheduleReconnect(): void {
		if (!this.shouldUseThumbnailWebSocket()) {
			return;
		}
		if (this.connectAttemptCount >= this.maxConnectAttempts) {
			return;
		}
		if (this.reconnectTimer != null) return;
		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, 3000);
	}
}

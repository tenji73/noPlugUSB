export const environment = {
	production: true,
	/**
	 * When true, the thumbnail WebSocket client is never started.
	 * Use when a proxy/tunnel cannot forward WebSockets (errors spam the console).
	 * Production builds skip the WebSocket regardless; this overrides development only.
	 */
	disableThumbnailWebSocket: false,
};

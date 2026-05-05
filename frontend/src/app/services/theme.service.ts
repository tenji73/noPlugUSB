import { Injectable, signal, computed } from '@angular/core';

export const THEME_STORAGE_KEY = 'noplug-theme';

/** Extend this list + add matching `[data-theme="…"]` rules in `styles.css`. */
export const THEME_OPTIONS = [
	{ id: 'dark', label: 'Dark' },
	{ id: 'light', label: 'Light' },
	{ id: 'gray', label: 'Gray' },
] as const;

export type ThemeId = (typeof THEME_OPTIONS)[number]['id'];

function isThemeId(value: string | null): value is ThemeId {
	return value != null && THEME_OPTIONS.some((t) => t.id === value);
}

@Injectable({ providedIn: 'root' })
export class ThemeService {
	/** Current theme id (also mirrored on `document.documentElement.dataset['theme']`). */
	readonly themeId = signal<ThemeId>('dark');

	readonly themes = THEME_OPTIONS;

	readonly currentLabel = computed(() => {
		const id = this.themeId();
		return THEME_OPTIONS.find((t) => t.id === id)?.label ?? id;
	});

	constructor() {
		this.applyFromStorage();
	}

	/** Call on bootstrap; `index.html` inline script sets `data-theme` early to reduce flash. */
	applyFromStorage(): void {
		let stored: string | null = null;
		try {
			stored = localStorage.getItem(THEME_STORAGE_KEY);
		} catch {
			/* private mode */
		}
		const id = isThemeId(stored) ? stored : 'dark';
		this.setTheme(id, false);
	}

	setTheme(id: ThemeId, persist = true): void {
		document.documentElement.dataset['theme'] = id;
		this.themeId.set(id);
		if (persist) {
			try {
				localStorage.setItem(THEME_STORAGE_KEY, id);
			} catch {
				/* ignore */
			}
		}
	}
}

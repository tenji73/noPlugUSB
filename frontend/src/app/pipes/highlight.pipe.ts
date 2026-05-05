import { Pipe, PipeTransform, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Wraps case-insensitive matches of `phrase` in `<span class="highlightSearch">…</span>`.
 * Escapes HTML in `text` before highlighting so filenames cannot inject markup.
 */
@Pipe({
	name: 'highlight',
	standalone: true,
})
export class HighlightPipe implements PipeTransform {
	private sanitizer = inject(DomSanitizer);

	transform(text: string | null | undefined, phrase: string | null | undefined): SafeHtml {
		const raw = text ?? '';
		const escaped = escapeHtml(raw);
		const q = phrase?.trim();
		if (!q) {
			return this.sanitizer.bypassSecurityTrustHtml(escaped);
		}
		try {
			const re = new RegExp(`(${escapeRegExp(q)})`, 'gi');
			const highlighted = escaped.replace(re, '<span class="highlightSearch">$1</span>');
			return this.sanitizer.bypassSecurityTrustHtml(highlighted);
		} catch {
			return this.sanitizer.bypassSecurityTrustHtml(escaped);
		}
	}
}

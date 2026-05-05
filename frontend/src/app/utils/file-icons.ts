/** Font Awesome 6 class names for virtual file entries (see `styles.css` FA import). */
export function fontAwesomeFileIconClass(extension: string): string {
	const e = extension.toLowerCase();
	if (e === '.gcode') return 'fa-solid fa-file-code';
	if (e === '.ctb') return 'fa-solid fa-flask';
	if (e === '.stl') return 'fa-solid fa-cube';
	if (e === '.mp4') return 'fa-solid fa-film';
	return 'fa-regular fa-file';
}

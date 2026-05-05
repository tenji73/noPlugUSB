const fs = require('fs');

/**
 * Raspberry Pi deployment uses `/home/pi/noplugusb/...` paths. Many systemd units run `node`
 * without `NODE_ENV=production`, so we also detect that layout on disk.
 * @returns {boolean}
 */
function isProductionRuntime() {
	if (process.env.NODE_ENV === 'production') return true;
	if (process.env.NODE_ENV === 'development') return false;
	try {
		return fs.existsSync('/home/pi/noplugusb/data/drives');
	} catch {
		return false;
	}
}

module.exports = { isProductionRuntime };

class UsbMockService {
	async disconnectPrinter() {
		console.log('\n[MOCK HARDWARE] 🔌 Initiating Printer Disconnect...');
		console.log('[MOCK BASH] Executing: sudo modprobe -r g_mass_storage');

		return new Promise((resolve) => {
			// Fake a 1.5-second delay to simulate Linux processing
			setTimeout(() => {
				console.log('[MOCK HARDWARE] ✅ Virtual USB successfully yanked from printer.');
				resolve('Printer disconnected');
			}, 1500);
		});
	}

	async connectPrinter(driveName) {
		console.log(`\n[MOCK HARDWARE] 🔌 Connecting ${driveName} to Printer...`);
		console.log(`[MOCK BASH] Executing: sudo modprobe g_mass_storage file=/drives/${driveName} ro=0 stall=0`);

		return new Promise((resolve) => {
			setTimeout(() => {
				console.log('[MOCK HARDWARE] ✅ Virtual USB plugged into printer.');
				resolve(`Printer connected to ${driveName}`);
			}, 1500);
		});
	}
}

module.exports = new UsbMockService();

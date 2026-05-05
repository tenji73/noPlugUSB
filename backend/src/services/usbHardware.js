const { exec } = require('child_process');
const util = require('util');
const path = require('path');
const { setTimeout: delay } = require('timers/promises');

const execPromise = util.promisify(exec);

const DRIVES_DIR = '/home/pi/noplugusb/data/drives';

/** ms to let the UDC / host settle after unloading the previous gadget before attaching another image. */
const REATTACH_SETTLE_MS = 500;

/**
 * Unload g_mass_storage if it is loaded (another virtual stick may be active).
 * @returns {Promise<boolean>} true if the module was loaded and removed
 */
async function unloadGadget() {
    try {
        await execPromise(`sudo modprobe -r g_mass_storage`);
        return true;
    } catch (error) {
        if (error.message.includes('not currently loaded') || error.message.includes('not found')) {
            return false;
        }
        throw error;
    }
}

async function connectPrinter(filename) {
    console.log(`🔌 [HARDWARE] Bridging ${filename} to 3D Printer...`);
    const drivePath = path.join(DRIVES_DIR, filename);
    try {
        console.log(`🔌 [HARDWARE] Clearing any existing USB mass-storage gadget...`);
        const hadPrevious = await unloadGadget();
        if (hadPrevious) {
            console.log(`✅ [HARDWARE] Previous gadget unloaded.`);
            console.log(
                `🔌 [HARDWARE] Waiting ${REATTACH_SETTLE_MS}ms before attaching new image (UDC settle)...`,
            );
            await delay(REATTACH_SETTLE_MS);
        } else {
            console.log(`✅ [HARDWARE] No gadget was active.`);
        }
        const cmd = `sudo modprobe g_mass_storage file="${drivePath}" stall=0 ro=0 removable=1`;
        await execPromise(cmd);
        console.log(`✅ [HARDWARE] USB Connection Established.`);
        return `Drive ${filename} connected to printer.`;
    } catch (error) {
        console.error('❌ [HARDWARE ERROR] Failed to connect USB:', error.message);
        throw error;
    }
}

async function disconnectPrinter() {
    console.log(`🔌 [HARDWARE] Severing USB connection...`);
    try {
        const had = await unloadGadget();
        if (had) {
            console.log(`✅ [HARDWARE] USB Disconnected.`);
            return 'USB safely disconnected.';
        }
        console.log(`✅ [HARDWARE] USB was already disconnected.`);
        return 'USB was already disconnected.';
    } catch (error) {
        console.error('❌ [HARDWARE ERROR] Failed to disconnect USB:', error.message);
        throw error;
    }
}

module.exports = { connectPrinter, disconnectPrinter };


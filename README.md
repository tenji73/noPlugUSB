# 🔌 NoPlugUSB

**The Wireless Virtual Drive Manager for "Dumb" Hardware**


NoPlugUSB is an open-source hardware and software solution that eliminates the "USB Shuffle." By transforming a Raspberry Pi Zero 2 W into a smart, Wi-Fi-enabled virtual flash drive, it allows users to wirelessly manage, upload, and swap files directly to 3D printers, CNC machines, and Smart TVs without ever touching a physical USB stick.

---

## 🛑 The Problem
Moving files to offline hardware traditionally requires constant physical intervention: ejecting a USB stick from your computer, walking it over to a 3D printer or media player, plugging it in, and repeating the process for every single file update or reprint. It is tedious, risks corrupting the flash drive, and breaks workflow automation.

## 💡 The Solution
NoPlugUSB acts as a digital bridge. Plugged directly into the USB port of your target device (e.g., a resin printer), the Raspberry Pi appears to the machine exactly like a standard, physical USB flash drive.

Users access a premium, modern web dashboard from their laptop or phone to manage the Pi. From this UI, users can create multiple "Virtual Drives," wirelessly drag-and-drop files onto them, and seamlessly command the Pi to connect or disconnect these virtual drives from the host machine with a single click.

---

## ⚙️ How It Works (Under the Hood)
NoPlugUSB combines low-level Linux hardware emulation with a modern web stack:

* **Hardware Emulation:** It utilizes the Linux kernel's USB Gadget Mode (`g_mass_storage`) to emulate a physical mass storage device.
* **The Backend (Node.js/Express):** A robust Node server acts as the orchestrator. Virtual drives are actually `.bin` files living on the Pi's SD card. The backend securely executes Linux bash commands to allocate space (`fallocate`), format file systems (`mkfs.vfat`), mount loops for file transfer, and toggle the USB connection state.
* **The Frontend (Angular 21 + Tailwind CSS):** A responsive, dark-mode web application provides a native operating system feel. It features real-time hardware state syncing, preventing users from corrupting data by locking the UI when the drive is actively being read by the host machine.

---

## ✨ Key Features

* **🗂️ Multi-Drive Ecosystem:** Create unlimited virtual drives (e.g., a 4GB FAT32 drive for 3D printing miniatures, and an 8GB exFAT drive for TV movies) and swap which one is plugged into the machine instantly.
* **☁️ Drag-and-Drop File Manager:** Upload massive `.ctb` resin slices or `.mp4` video files directly through the browser.
* **🛡️ Hardware-Aware Safety:** The system constantly calculates available disk space, blocking uploads that exceed the virtual drive's capacity *before* the transfer even begins.
* **📂 Smart Folder Flattening:** Modern TVs love nested folders, but 3D printers often crash when reading them. NoPlugUSB automatically intercepts folder uploads and offers to "Smart Flatten" them—retaining the organizational naming structure while keeping the files strictly in the root directory for maximum hardware compatibility.

---

## 🎯 Target Use Cases

1. **3D Printing (Resin & FDM):** Send sliced files from your slicer directly to the printer's screen.
2. **Home Media:** Wirelessly push movies or photos to a Smart TV or projector.
3. **Industrial/Maker:** Update G-code on CNC routers or laser cutters without removing the SD card or USB.

---

## 🛒 Hardware Requirements

To build the NoPlugUSB appliance, you will need:
1. **A Raspberry Pi Zero 2 W** (Pi 4 and Pi 5 also work via their USB-C ports).
2. **A High-Quality 5V/2.5A Wall Charger** to power the Pi independently.
3. **A Modified Micro-USB Data Cable**

⚠️ **CRITICAL POWER WARNING:** You cannot power the Pi from the 3D printer's USB port. The printer cannot supply enough amperage, which causes the Pi's Wi-Fi to constantly disconnect due to hardware brownouts.
* **The Fix:** Take a standard micro-USB data cable, carefully strip the outer jacket, and **cut the RED (5V) wire**. Leave the Black, Green, and White wires completely intact.
* Plug this modified data-only cable into the Pi's inner data USB port and the printer. Plug your wall charger into the Pi's outer "PWR" port.

---

## 🚀 Quick Start Installation

NoPlugUSB comes with a fully automated, one-click installation script that configures the Linux kernel, sets up the Wi-Fi watchdog, and installs the web interface as a background service.

**1. Prepare the SD Card**
Use the official [Raspberry Pi Imager](https://www.raspberrypi.com/software/) to flash **Raspberry Pi OS Lite (64-bit or 32-bit)** to an SD card. Use the "OS Customization" settings in the Imager to input your Wi-Fi credentials and enable SSH.

**2. Run the Installer**
Boot the Pi, SSH into it, and run the following commands:

```bash
git clone [https://github.com/tenji73/noPlugUSB.git](https://github.com/tenji73/noPlugUSB.git)
cd noPlugUSB
sudo chmod +x install.sh
sudo ./install.sh
```
**3. Reboot and Connect**
 *  Once the script finishes, run sudo reboot.
  * After the Pi turns back on, open a web browser on any device connected to your Wi-Fi and navigate to:http://<your-raspberry-pi-ip>

You will be greeted by the NoPlugUSB dashboard and can begin creating your first virtual drive!

## 🛠️ Tech Stack
* Frontend: Angular 21, Tailwind CSS
* Backend: Node.js, Express, Multer
* Hardware: Raspberry Pi Zero 2 W (Linux `dwc2` and `g_mass_storage)


## 📋 Logs and Troubleshooting
The backend runs as a `systemd service named `noplugusb`. Logs are piped directly to `journald`.

To view the last 200 lines and follow new log lines:
```bash
sudo journalctl -u noplugusb -n 200 -f
```
To restart the application manually:
```
sudo systemctl restart noplugusb
```

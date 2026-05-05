# 🔌 NoPlugUSB

**The Wireless Virtual Drive Manager for "Dumb" Hardware**

NoPlugUSB is an open-source hardware and software solution that eliminates the "USB Shuffle." By transforming a Raspberry Pi Zero W into a smart, Wi-Fi-enabled virtual flash drive, it allows users to wirelessly manage, upload, and swap files directly to 3D printers, CNC machines, and Smart TVs without ever touching a physical USB stick.

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

## 🛠️ Tech Stack
* **Frontend:** Angular 21, Tailwind CSS
* **Backend:** Node.js, Express, Multer
* **Hardware:** Raspberry Pi Zero W (or similar Linux SBC)

## Logs and restart (Raspberry Pi)

Backend logs go to **journald** when the app runs under systemd (`noplugusb`):

```bash
# Last 200 lines, then follow new log lines
sudo journalctl -u noplugusb -n 200 --no-pager
sudo journalctl -u noplugusb -f
```

After deploying code:

```bash
sudo systemctl restart noplugusb
```

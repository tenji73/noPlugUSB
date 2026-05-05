#!/bin/bash

# Exit immediately if a command fails
set -e

echo "🚀 Starting NoPlugUSB Appliance Installation..."

# 1. Enforce root privileges
if [ "$EUID" -ne 0 ]; then
  echo "❌ Please run this script with sudo: sudo ./install.sh"
  exit 1
fi

# Get the absolute path of where the user cloned the repo
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
BACKEND_DIR="$INSTALL_DIR/backend"
DATA_DIR="$INSTALL_DIR/data"

echo "📂 Installation directory detected as: $INSTALL_DIR"

# 2. Install System Dependencies
echo "📦 Updating package lists and installing dependencies..."
apt-get update
apt-get install -y nodejs npm dosfstools libvips-dev

# 3. Configure USB Gadget Mode (Kernel Overlays)
echo "🔌 Configuring Linux Kernel for USB Gadget Mode..."
BOOT_CONFIG="/boot/firmware/config.txt"
if [ ! -f "$BOOT_CONFIG" ]; then
    BOOT_CONFIG="/boot/config.txt"
fi

if ! grep -q "dtoverlay=dwc2" "$BOOT_CONFIG"; then
    echo "dtoverlay=dwc2" >> "$BOOT_CONFIG"
fi

if ! grep -q "dwc2" /etc/modules; then
    echo "dwc2" >> /etc/modules
fi

if ! grep -q "g_mass_storage" /etc/modules; then
    echo "g_mass_storage" >> /etc/modules
fi

# 4. Set up the Nuclear Wi-Fi Watchdog (Stability Patch)
echo "🐕 Setting up Wi-Fi Watchdog and Power overrides..."
WATCHDOG_SCRIPT="/usr/local/bin/wifi-watchdog.sh"
cat <<EOF > "$WATCHDOG_SCRIPT"
#!/bin/bash
SERVER=8.8.8.8
ping -c 4 \$SERVER > /dev/null
if [ \$? != 0 ]; then
    echo "\$(date): Network failed! Initiating nuclear driver reload..." >> /var/log/wifi-watchdog.log
    systemctl stop NetworkManager
    modprobe -r brcmfmac
    sleep 2
    modprobe brcmfmac
    sleep 3
    systemctl start NetworkManager
fi
EOF
chmod +x "$WATCHDOG_SCRIPT"

# Add Cron Jobs (Watchdog + Hardware Power Save Override)
if ! crontab -l 2>/dev/null | grep -q "wifi-watchdog.sh"; then
    (crontab -l 2>/dev/null; echo "*/5 * * * * $WATCHDOG_SCRIPT") | crontab -
fi
if ! crontab -l 2>/dev/null | grep -q "iw dev wlan0 set power_save off"; then
    (crontab -l 2>/dev/null; echo "@reboot sleep 30 && /sbin/iw dev wlan0 set power_save off") | crontab -
fi

# 5. Set up the Virtual Drive Directories
echo "💽 Creating virtual drive storage..."
mkdir -p "$DATA_DIR/drives"
mkdir -p "$DATA_DIR/uploads"
mkdir -p "$DATA_DIR/stats_mount_loop"
chmod -R 777 "$DATA_DIR"

# 6. Install Backend Node Dependencies (Production Only)
echo "⚙️ Installing Node.js backend modules..."
cd "$BACKEND_DIR"
if [ ! -f ".env" ] && [ -f ".env.example" ]; then
    cp .env.example .env
fi
npm install --omit=dev

# 7. Create and Enable the Systemd Background Service
echo "🛠️ Creating Systemd background service..."
SERVICE_FILE="/etc/systemd/system/noplugusb.service"

cat <<EOF > "$SERVICE_FILE"
[Unit]
Description=NoPlugUSB Hardware Appliance Backend
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$BACKEND_DIR
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable noplugusb

echo "========================================================"
echo "✅ NoPlugUSB Installation Complete!"
echo "========================================================"
echo "⚠️ CRITICAL: To prevent Wi-Fi dropouts, you MUST power the"
echo "Pi from a wall charger, NOT the 3D printer's USB port."
echo "Use a data cable with the 5V (Red) wire cut for safety."
echo "========================================================"
echo "Please run: sudo reboot"
echo "========================================================"

# Beam the code
rsync -avz --exclude 'node_modules' --exclude '.DS_Store' --exclude '.git' --exclude 'dist' ./ pi@noplugusb.local:/home/pi/noplugusb/app/

# Tell the Pi to restart the service immediately
ssh pi@noplugusb.local "sudo systemctl restart noplugusb"

FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    rtl-sdr \
    librtlsdr-dev \
    libusb-1.0-0-dev \
    sox \
    libsox-fmt-all \
    && rm -rf /var/lib/apt/lists/*

# Blacklist kernel DVB-T driver so rtl-sdr can access the device
RUN echo "blacklist dvb_usb_rtl28xxu" > /etc/modprobe.d/blacklist-rtlsdr.conf

WORKDIR /app

COPY backend/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ /app/backend/
COPY frontend/ /app/frontend/

# Copy default presets; entrypoint copies to volume if empty
COPY data/ /app/data-defaults/
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

VOLUME /app/data
EXPOSE 8080

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["python", "backend/app.py"]

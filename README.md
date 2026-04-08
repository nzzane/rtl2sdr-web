# RTL-SDR Web UI

A Docker-based web application for RTL-SDR software defined radio receivers. Provides a mobile-friendly web interface for tuning, scanning, and visualizing radio frequencies.

## Features

- **Preset Channels** - Browse and tune to pre-configured frequencies with search and tag filtering
- **Scan Groups** - Scan through groups of frequencies automatically, pausing on active signals
- **Manual Tuning** - Tune to any frequency with full control over modulation, squelch, gain, and bandwidth
- **Spectrum Analyzer** - Sweep frequency ranges and view signal strength charts
- **Audio Streaming** - Real-time audio via WebSocket with Web Audio API playback
- **Waveform & FFT Display** - Live audio visualization with waveform and frequency spectrum
- **PWA Support** - Install as a mobile app with background audio playback
- **Channel Management** - Add, edit, and delete channels and scan groups from the web UI
- **Wellington NZ Presets** - Pre-loaded with local frequencies:
  - Aviation (Wellington Airport tower, ground, ATIS, approach)
  - Marine VHF (Ch 16 distress, port operations)
  - Amateur Radio (2m/70cm repeaters, simplex, APRS)
  - CB Radio (27 MHz AM channels)
  - UHF CB (477 MHz FM channels)
  - FM Broadcast (RNZ National, RNZ Concert, The Edge)
  - Emergency channels

## Quick Start

```bash
docker compose up --build
```

Open **http://localhost:8080** in your browser.

## Requirements

- Docker & Docker Compose
- RTL-SDR USB dongle connected to the host
- Host must have USB passthrough enabled for Docker

## Host Setup

Ensure the RTL-SDR kernel module is blacklisted on the host so rtl-sdr userspace tools can access the device:

```bash
echo "blacklist dvb_usb_rtl28xxu" | sudo tee /etc/modprobe.d/blacklist-rtlsdr.conf
sudo modprobe -r dvb_usb_rtl28xxu
```

## Architecture

```
┌──────────────────────────────────────────┐
│  Browser (PWA)                           │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│  │ Web Audio │ │ Canvas   │ │ Controls │ │
│  │ API      │ │ Viz      │ │          │ │
│  └────┬─────┘ └──────────┘ └────┬─────┘ │
│       │  WebSocket (binary PCM) │  REST  │
└───────┼─────────────────────────┼────────┘
        │                         │
┌───────┼─────────────────────────┼────────┐
│  Docker Container               │        │
│  ┌────┴─────────────────────────┴──────┐ │
│  │  FastAPI (Python)                   │ │
│  │  ├── /ws/audio  (WebSocket stream)  │ │
│  │  ├── /ws/status (status push)       │ │
│  │  ├── /api/*     (REST endpoints)    │ │
│  │  └── Static files (frontend)        │ │
│  └────┬────────────────────────────────┘ │
│       │                                  │
│  ┌────┴────────────────────────────────┐ │
│  │  rtl_fm → sox (audio pipeline)      │ │
│  │  rtl_power (spectrum sweeps)        │ │
│  └────┬────────────────────────────────┘ │
│       │ USB                              │
└───────┼──────────────────────────────────┘
        │
   ┌────┴─────┐
   │ RTL-SDR  │
   │ USB      │
   └──────────┘
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | SDR status and tool availability |
| GET | `/api/presets` | All channels and groups |
| POST | `/api/presets/channel` | Add a channel |
| PUT | `/api/presets/channel/:id` | Update a channel |
| DELETE | `/api/presets/channel/:id` | Delete a channel |
| POST | `/api/presets/group` | Add a scan group |
| PUT | `/api/presets/group/:id` | Update a group |
| DELETE | `/api/presets/group/:id` | Delete a group |
| POST | `/api/tune` | Tune to a frequency |
| POST | `/api/stop` | Stop all SDR activity |
| POST | `/api/scan` | Start scanning a group |
| POST | `/api/scan/stop` | Stop scanning |
| POST | `/api/spectrum` | Run a spectrum sweep |

## WebSocket Endpoints

- `/ws/audio` - Binary PCM audio stream (16-bit signed, 48kHz, mono)
- `/ws/status` - JSON status updates (0.5s interval)

## Mobile Background Playback

The app registers as a PWA. On mobile:
1. Open in browser and use "Add to Home Screen"
2. Audio continues playing when the screen is off via a silent audio element keepalive

## Configuration

Presets are stored in `data/presets.json` and persist across container restarts via the Docker volume mount.

## License

MIT

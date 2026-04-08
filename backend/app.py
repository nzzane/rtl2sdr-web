"""RTL-SDR Web UI - FastAPI backend."""

import asyncio
import json
import logging
import os
import struct
import base64
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from sdr import SDRStream, SDRScanner, SpectrumAnalyzer, check_tools, SAMPLE_RATE

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
PRESETS_FILE = DATA_DIR / "presets.json"
FRONTEND_DIR = BASE_DIR / "frontend"

app = FastAPI(title="RTL-SDR Web UI")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global SDR state
sdr_stream = SDRStream()
scanner = SDRScanner(sdr_stream)
spectrum = SpectrumAnalyzer()
audio_clients: set[WebSocket] = set()


def load_presets():
    """Load presets from JSON file."""
    if PRESETS_FILE.exists():
        with open(PRESETS_FILE) as f:
            return json.load(f)
    return {"channels": [], "groups": []}


def save_presets(data):
    """Save presets to JSON file."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(PRESETS_FILE, "w") as f:
        json.dump(data, f, indent=2)


# --- REST API ---

@app.get("/api/status")
async def get_status():
    """Get current SDR status."""
    tools = check_tools()
    return {
        "tools": tools,
        "streaming": sdr_stream.is_active,
        "scanning": scanner.scanning,
        "current_freq": sdr_stream.current_freq,
        "sample_rate": SAMPLE_RATE,
    }


@app.get("/api/presets")
async def get_presets():
    """Get all preset channels and groups."""
    return load_presets()


@app.post("/api/presets")
async def update_presets(data: dict):
    """Update presets (full replace)."""
    save_presets(data)
    return {"ok": True}


@app.post("/api/presets/channel")
async def add_channel(channel: dict):
    """Add a single channel to presets."""
    presets = load_presets()
    # Assign ID
    max_id = max((ch.get("id", 0) for ch in presets["channels"]), default=0)
    channel["id"] = max_id + 1
    presets["channels"].append(channel)
    save_presets(presets)
    return channel


@app.put("/api/presets/channel/{channel_id}")
async def update_channel(channel_id: int, channel: dict):
    """Update an existing channel."""
    presets = load_presets()
    for i, ch in enumerate(presets["channels"]):
        if ch.get("id") == channel_id:
            channel["id"] = channel_id
            presets["channels"][i] = channel
            save_presets(presets)
            return channel
    return JSONResponse(status_code=404, content={"error": "Channel not found"})


@app.delete("/api/presets/channel/{channel_id}")
async def delete_channel(channel_id: int):
    """Delete a channel."""
    presets = load_presets()
    presets["channels"] = [ch for ch in presets["channels"] if ch.get("id") != channel_id]
    save_presets(presets)
    return {"ok": True}


@app.post("/api/presets/group")
async def add_group(group: dict):
    """Add a scan group."""
    presets = load_presets()
    max_id = max((g.get("id", 0) for g in presets["groups"]), default=0)
    group["id"] = max_id + 1
    presets["groups"].append(group)
    save_presets(presets)
    return group


@app.put("/api/presets/group/{group_id}")
async def update_group(group_id: int, group: dict):
    """Update an existing group."""
    presets = load_presets()
    for i, g in enumerate(presets["groups"]):
        if g.get("id") == group_id:
            group["id"] = group_id
            presets["groups"][i] = group
            save_presets(presets)
            return group
    return JSONResponse(status_code=404, content={"error": "Group not found"})


@app.delete("/api/presets/group/{group_id}")
async def delete_group(group_id: int):
    """Delete a group."""
    presets = load_presets()
    presets["groups"] = [g for g in presets["groups"] if g.get("id") != group_id]
    save_presets(presets)
    return {"ok": True}


@app.post("/api/tune")
async def tune(params: dict):
    """Tune to a specific frequency."""
    await scanner.stop()

    freq = params.get("freq")
    if not freq:
        return JSONResponse(status_code=400, content={"error": "freq is required"})

    await sdr_stream.start(
        freq_hz=int(freq),
        modulation=params.get("modulation", "fm"),
        squelch=int(params.get("squelch", 0)),
        gain=params.get("gain", "auto"),
        bandwidth=params.get("bandwidth"),
        ppm=int(params.get("ppm", 0)),
        device_index=int(params.get("device_index", 0)),
    )
    return {
        "ok": True,
        "freq": freq,
        "streaming": sdr_stream.is_active,
    }


@app.post("/api/stop")
async def stop():
    """Stop all SDR activity."""
    await scanner.stop()
    await sdr_stream.stop()
    return {"ok": True}


@app.post("/api/scan")
async def start_scan(params: dict):
    """Start scanning a group of frequencies."""
    frequencies = params.get("frequencies", [])
    if not frequencies:
        return JSONResponse(status_code=400, content={"error": "frequencies list required"})

    await scanner.start(
        frequencies=[int(f) for f in frequencies],
        modulation=params.get("modulation", "fm"),
        squelch=int(params.get("squelch", 10)),
        dwell_time=float(params.get("dwell_time", 2.0)),
        active_dwell_time=float(params.get("active_dwell_time", 5.0)),
    )
    return {"ok": True, "scanning": True, "num_frequencies": len(frequencies)}


@app.post("/api/scan/stop")
async def stop_scan():
    """Stop scanning."""
    await scanner.stop()
    return {"ok": True, "scanning": False}


@app.post("/api/spectrum")
async def get_spectrum(params: dict):
    """Get spectrum data for a frequency range."""
    start = params.get("start")
    stop = params.get("stop")
    if not start or not stop:
        return JSONResponse(status_code=400, content={"error": "start and stop required"})

    data = await spectrum.sweep(
        start_hz=int(start),
        stop_hz=int(stop),
        bin_size=int(params.get("bin_size", 10000)),
        integration_time=int(params.get("integration_time", 1)),
        gain=params.get("gain", "auto"),
        ppm=int(params.get("ppm", 0)),
    )
    return {"data": data}


# --- WebSocket for audio streaming ---

@app.websocket("/ws/audio")
async def audio_websocket(ws: WebSocket):
    """Stream raw PCM audio to the client via WebSocket."""
    await ws.accept()
    audio_clients.add(ws)
    logger.info("Audio client connected (%d total)", len(audio_clients))

    try:
        while True:
            # Handle incoming messages (control commands)
            try:
                msg = await asyncio.wait_for(ws.receive_text(), timeout=0.01)
                data = json.loads(msg)
                cmd = data.get("cmd")

                if cmd == "tune":
                    await scanner.stop()
                    await sdr_stream.start(
                        freq_hz=int(data["freq"]),
                        modulation=data.get("modulation", "fm"),
                        squelch=int(data.get("squelch", 0)),
                        gain=data.get("gain", "auto"),
                        bandwidth=data.get("bandwidth"),
                        ppm=int(data.get("ppm", 0)),
                    )
                    await ws.send_json({"event": "tuned", "freq": data["freq"]})

                elif cmd == "stop":
                    await scanner.stop()
                    await sdr_stream.stop()
                    await ws.send_json({"event": "stopped"})

                elif cmd == "scan":
                    freqs = [int(f) for f in data.get("frequencies", [])]
                    await scanner.start(
                        frequencies=freqs,
                        modulation=data.get("modulation", "fm"),
                        squelch=int(data.get("squelch", 10)),
                    )
                    await ws.send_json({"event": "scanning", "count": len(freqs)})

            except asyncio.TimeoutError:
                pass

            # Stream audio data if active
            if sdr_stream.is_active:
                audio_data = await sdr_stream.read_audio(chunk_size=8192)
                if audio_data:
                    # Send as binary WebSocket frame
                    await ws.send_bytes(audio_data)
            else:
                await asyncio.sleep(0.05)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error("WebSocket error: %s", e)
    finally:
        audio_clients.discard(ws)
        logger.info("Audio client disconnected (%d remaining)", len(audio_clients))


@app.websocket("/ws/status")
async def status_websocket(ws: WebSocket):
    """Push status updates to clients."""
    await ws.accept()
    try:
        while True:
            status = {
                "streaming": sdr_stream.is_active,
                "scanning": scanner.scanning,
                "current_freq": sdr_stream.current_freq,
                "scan_index": scanner.current_index if scanner.scanning else None,
                "scan_total": len(scanner.frequencies) if scanner.scanning else None,
            }
            await ws.send_json(status)
            await asyncio.sleep(0.5)
    except WebSocketDisconnect:
        pass


# --- Static files ---

app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


@app.get("/")
async def index():
    return FileResponse(str(FRONTEND_DIR / "index.html"))


@app.get("/manifest.json")
async def manifest():
    return FileResponse(str(FRONTEND_DIR / "manifest.json"))


@app.get("/sw.js")
async def service_worker():
    return FileResponse(str(FRONTEND_DIR / "sw.js"), media_type="application/javascript")


if __name__ == "__main__":
    import uvicorn
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run(app, host=host, port=port, log_level="info")

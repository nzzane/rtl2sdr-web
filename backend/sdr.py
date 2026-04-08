"""RTL-SDR interface using rtl_fm and rtl_power command-line tools."""

import asyncio
import logging
import os
import signal
import shutil

logger = logging.getLogger(__name__)

SAMPLE_RATE = 48000  # Audio sample rate for output
RTL_FM_BIN = "rtl_fm"
RTL_POWER_BIN = "rtl_power"


def check_tools():
    """Check if required RTL-SDR tools are available."""
    tools = {}
    for tool in [RTL_FM_BIN, RTL_POWER_BIN, "sox"]:
        tools[tool] = shutil.which(tool) is not None
    return tools


class SDRStream:
    """Manages an rtl_fm process and streams audio via a callback."""

    def __init__(self):
        self.process = None
        self.running = False
        self._freq = None
        self._modulation = "fm"
        self._squelch = 0
        self._gain = "auto"
        self._bandwidth = None
        self._ppm = 0
        self._device_index = 0
        self._last_error = None
        self._state = "idle"  # idle, starting, receiving, error, stopped

    @property
    def is_active(self):
        return self.running and self.process is not None

    @property
    def current_freq(self):
        return self._freq

    @property
    def current_squelch(self):
        return self._squelch

    @property
    def state(self):
        return self._state

    @property
    def last_error(self):
        return self._last_error

    def get_status(self):
        return {
            "state": self._state,
            "freq": self._freq,
            "modulation": self._modulation,
            "gain": self._gain,
            "error": self._last_error,
        }

    async def start(self, freq_hz, modulation="fm", squelch=0, gain="auto",
                    bandwidth=None, ppm=0, device_index=0):
        """Start receiving on a frequency.

        squelch: server-side squelch level (used by scanner). For manual tuning
        the UI applies client-side squelch instead (instant, no restart).
        """
        await self.stop()

        self._last_error = None
        self._state = "starting"
        self._freq = freq_hz
        self._modulation = modulation
        self._squelch = squelch
        self._gain = gain
        self._bandwidth = bandwidth
        self._ppm = ppm
        self._device_index = device_index

        # Build rtl_fm command
        cmd = [RTL_FM_BIN]
        cmd += ["-d", str(device_index)]
        cmd += ["-f", str(freq_hz)]
        cmd += ["-M", modulation]
        cmd += ["-s", str(self._get_sample_rate(modulation, bandwidth))]
        cmd += ["-p", str(ppm)]

        if gain != "auto":
            cmd += ["-g", str(gain)]

        if squelch > 0:
            cmd += ["-l", str(squelch)]

        if bandwidth and modulation not in ("wbfm",):
            cmd += ["-W", str(bandwidth)]

        # Pipe through sox to convert to 16-bit PCM at target sample rate
        sox_cmd = [
            "sox", "-t", "raw", "-r", str(self._get_sample_rate(modulation, bandwidth)),
            "-e", "signed", "-b", "16", "-c", "1", "-",
            "-t", "raw", "-r", str(SAMPLE_RATE),
            "-e", "signed", "-b", "16", "-c", "1", "-"
        ]

        # Pipe rtl_fm stdout (audio) to sox. Discard stderr from both.
        # IMPORTANT: Do NOT use 2>&1 here - that mixes rtl_fm's text status
        # messages into the audio pipe, corrupting sox input and killing the stream.
        full_cmd = " ".join(cmd) + " 2>/dev/null | " + " ".join(sox_cmd) + " 2>/dev/null"

        logger.info("Starting SDR: %s", full_cmd)

        try:
            self.process = await asyncio.create_subprocess_shell(
                full_cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                preexec_fn=os.setsid,  # Create new process group for clean kill
            )
        except Exception as e:
            self._last_error = f"Failed to start rtl_fm: {e}"
            self._state = "error"
            logger.error("Failed to start SDR process: %s", e)
            return

        self.running = True
        self._state = "receiving"

        # Start a background task to monitor stderr for errors
        asyncio.create_task(self._monitor_process())

        logger.info("SDR stream started on %.6f MHz (%s)", freq_hz / 1e6, modulation)

    async def _monitor_process(self):
        """Monitor the SDR process for early termination / errors."""
        if not self.process:
            return
        try:
            retcode = await asyncio.wait_for(self.process.wait(), timeout=2.0)
            # Process exited within 2 seconds - likely an error
            if retcode != 0 and self.running:
                stderr_data = b""
                if self.process.stderr:
                    try:
                        stderr_data = await asyncio.wait_for(
                            self.process.stderr.read(4096), timeout=1.0
                        )
                    except asyncio.TimeoutError:
                        pass
                err_msg = stderr_data.decode(errors="replace").strip()
                if err_msg:
                    # Clean up common rtl_fm error messages
                    for line in err_msg.split("\n"):
                        line = line.strip()
                        if line and not line.startswith("Found") and not line.startswith("Exact"):
                            self._last_error = line
                            break
                else:
                    self._last_error = f"rtl_fm exited with code {retcode}"
                self._state = "error"
                self.running = False
                logger.error("SDR process failed: %s", self._last_error)
        except asyncio.TimeoutError:
            # Process still running after 2s - good, it's working
            pass

    async def read_audio(self, chunk_size=4096):
        """Read a chunk of raw PCM audio data."""
        if not self.is_active or self.process.stdout is None:
            return None
        try:
            data = await asyncio.wait_for(
                self.process.stdout.read(chunk_size),
                timeout=2.0
            )
            if not data:
                self.running = False
                if self._state == "receiving":
                    self._state = "stopped"
                    self._last_error = "Stream ended unexpectedly"
                return None
            if self._state != "receiving":
                self._state = "receiving"
            return data
        except asyncio.TimeoutError:
            return None
        except Exception as e:
            logger.error("Error reading audio: %s", e)
            self._last_error = str(e)
            self._state = "error"
            self.running = False
            return None

    async def audio_has_signal(self, threshold=500, chunk_size=4096):
        """Check if the audio stream has signal above noise floor.

        Reads a chunk and computes RMS of 16-bit samples.
        threshold: RMS level (0-32768) above which we consider signal present.
        Returns True if signal detected, False otherwise.
        """
        data = await self.read_audio(chunk_size)
        if not data or len(data) < 4:
            return False
        import struct
        samples = struct.unpack(f"<{len(data)//2}h", data)
        rms = (sum(s * s for s in samples) / len(samples)) ** 0.5
        return rms > threshold

    async def stop(self):
        """Stop the current SDR stream."""
        if self.process:
            try:
                # Kill the entire process group to ensure rtl_fm and sox are both killed
                pgid = os.getpgid(self.process.pid)
                os.killpg(pgid, signal.SIGTERM)
                await asyncio.wait_for(self.process.wait(), timeout=2.0)
            except (asyncio.TimeoutError, ProcessLookupError, OSError):
                try:
                    pgid = os.getpgid(self.process.pid)
                    os.killpg(pgid, signal.SIGKILL)
                except (ProcessLookupError, OSError):
                    pass
                try:
                    self.process.kill()
                except ProcessLookupError:
                    pass
            self.process = None
        self.running = False
        self._freq = None
        self._state = "idle"
        logger.info("SDR stream stopped")

    def _get_sample_rate(self, modulation, bandwidth):
        """Get appropriate sample rate for the modulation type."""
        if modulation == "wbfm":
            return 170000
        if bandwidth:
            return max(bandwidth * 2, 24000)
        return 24000


class SDRScanner:
    """Scans through a list of frequencies, pausing on active ones."""

    def __init__(self, sdr_stream: SDRStream):
        self.sdr = sdr_stream
        self.frequencies = []
        self.current_index = 0
        self.scanning = False
        self._scan_task = None
        self.dwell_time = 2.0
        self.active_dwell_time = 5.0
        self.squelch = 10
        self.modulation = "fm"
        self.on_frequency_change = None

    async def start(self, frequencies, modulation="fm", squelch=10,
                    dwell_time=2.0, active_dwell_time=5.0):
        """Start scanning through frequencies."""
        await self.stop()
        self.frequencies = frequencies
        self.modulation = modulation
        self.squelch = squelch
        self.dwell_time = dwell_time
        self.active_dwell_time = active_dwell_time
        self.current_index = 0
        self.scanning = True
        self._scan_task = asyncio.create_task(self._scan_loop())
        logger.info("Scanner started with %d frequencies", len(frequencies))

    async def stop(self):
        """Stop scanning."""
        self.scanning = False
        if self._scan_task:
            self._scan_task.cancel()
            try:
                await self._scan_task
            except asyncio.CancelledError:
                pass
            self._scan_task = None

    async def _scan_loop(self):
        """Main scan loop - holds on channels with signal like a real radio scanner.

        Behaviour:
        1. Tune to frequency, wait briefly for rtl_fm to settle
        2. Sample audio to check if there's a signal (RMS above threshold)
        3. If signal: stay on channel, keep checking every second until signal drops
        4. If no signal: move to next frequency after dwell_time
        """
        while self.scanning and self.frequencies:
            freq = self.frequencies[self.current_index]
            await self.sdr.start(
                freq_hz=freq,
                modulation=self.modulation,
                squelch=self.squelch,
            )

            if self.on_frequency_change:
                await self.on_frequency_change(freq, self.current_index)

            # Wait for rtl_fm to settle and start producing audio
            await asyncio.sleep(0.5)

            # Check for signal
            has_signal = False
            if self.sdr.is_active:
                has_signal = await self.sdr.audio_has_signal(threshold=400)

            if has_signal:
                # Signal detected - hold on this channel
                logger.info("Scanner: signal on %.6f MHz - holding", freq / 1e6)
                hold_start = asyncio.get_event_loop().time()
                while self.scanning and self.sdr.is_active:
                    await asyncio.sleep(1.0)
                    still_active = await self.sdr.audio_has_signal(threshold=400)
                    if not still_active:
                        # Signal dropped - wait a short grace period
                        await asyncio.sleep(1.0)
                        still_active = await self.sdr.audio_has_signal(threshold=400)
                        if not still_active:
                            logger.info("Scanner: signal lost on %.6f MHz - resuming scan", freq / 1e6)
                            break
            else:
                # No signal - dwell briefly then move on
                await asyncio.sleep(self.dwell_time)

            if not self.scanning:
                break
            self.current_index = (self.current_index + 1) % len(self.frequencies)


class SpectrumAnalyzer:
    """Uses rtl_power to generate spectrum data."""

    def __init__(self):
        self.process = None
        self.running = False

    async def sweep(self, start_hz, stop_hz, bin_size=10000, integration_time=1,
                    device_index=0, ppm=0, gain="auto"):
        """Run a single spectrum sweep and return the data."""
        cmd = [
            RTL_POWER_BIN,
            "-d", str(device_index),
            "-f", f"{start_hz}:{stop_hz}:{bin_size}",
            "-i", str(integration_time),
            "-1",
            "-p", str(ppm),
        ]
        if gain != "auto":
            cmd += ["-g", str(gain)]

        cmd_str = " ".join(cmd)
        logger.info("Spectrum sweep: %s", cmd_str)

        try:
            proc = await asyncio.create_subprocess_shell(
                cmd_str,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
        except asyncio.TimeoutError:
            proc.kill()
            return []

        results = []
        for line in stdout.decode().strip().split("\n"):
            if not line:
                continue
            parts = line.split(", ")
            if len(parts) < 7:
                continue
            try:
                start = float(parts[2])
                bin_sz = float(parts[4])
                db_values = [float(v) for v in parts[6:]]
                for i, db in enumerate(db_values):
                    freq = start + i * bin_sz
                    results.append({"freq": freq, "power": db})
            except (ValueError, IndexError):
                continue

        return results

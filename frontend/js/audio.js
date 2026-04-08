/**
 * Audio engine - ring buffer playback with client-side squelch.
 *
 * Uses ScriptProcessorNode with a circular buffer for gapless audio.
 * Squelch is applied client-side by measuring RMS power and gating output.
 */
class AudioEngine {
  constructor() {
    this.audioCtx = null;
    this.scriptNode = null;
    this.analyserNode = null;
    this.ws = null;
    this.playing = false;
    this.volume = 0.8;
    this.sampleRate = 48000;

    // Ring buffer (2 seconds)
    this._bufferSize = 48000 * 2;
    this._ringBuffer = null;
    this._writePos = 0;
    this._readPos = 0;
    this._buffered = 0;

    // Client-side squelch
    this.squelchLevel = 0;   // 0-100, 0 = off
    this.isSquelched = false;
    this.audioRMS = 0;       // Current RMS power (0-1)
    this._rmsDecay = 0.92;

    // Silent audio element for mobile background playback
    this._silentAudio = null;

    // Callbacks
    this.onStatusChange = null;
    this.onSquelchChange = null; // (isSquelched, rms, threshold)
  }

  init() {
    if (this.audioCtx) return;

    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: this.sampleRate,
    });

    this._ringBuffer = new Float32Array(this._bufferSize);
    this._writePos = 0;
    this._readPos = 0;
    this._buffered = 0;

    // ScriptProcessor pulls from the ring buffer for gapless playback
    // Buffer size 4096 = ~85ms per callback at 48kHz
    this.scriptNode = this.audioCtx.createScriptProcessor(4096, 0, 1);

    this.analyserNode = this.audioCtx.createAnalyser();
    this.analyserNode.fftSize = 2048;
    this.analyserNode.smoothingTimeConstant = 0.8;

    this.scriptNode.onaudioprocess = (e) => this._processAudio(e);
    this.scriptNode.connect(this.analyserNode);
    this.analyserNode.connect(this.audioCtx.destination);

    this._setupBackgroundAudio();
  }

  connect() {
    if (this.ws && this.ws.readyState <= 1) return;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws/audio`;

    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      console.log('[Audio] WebSocket connected');
      this._notifyStatus();
    };

    this.ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        this._handleAudioData(e.data);
      } else {
        try {
          const msg = JSON.parse(e.data);
          this._handleControlMessage(msg);
        } catch (err) { /* ignore */ }
      }
    };

    this.ws.onclose = () => {
      console.log('[Audio] WebSocket disconnected');
      this._notifyStatus();
      setTimeout(() => { if (this.playing) this.connect(); }, 2000);
    };

    this.ws.onerror = (e) => {
      console.error('[Audio] WebSocket error', e);
    };
  }

  send(cmd) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd));
    }
  }

  play() {
    this.init();
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    this.playing = true;
    // Flush the ring buffer on play to avoid stale data
    this._writePos = 0;
    this._readPos = 0;
    this._buffered = 0;
    this.connect();
    this._startBackgroundAudio();
    this._notifyStatus();
  }

  stop() {
    this.playing = false;
    this._writePos = 0;
    this._readPos = 0;
    this._buffered = 0;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._stopBackgroundAudio();
    this._notifyStatus();
  }

  setVolume(val) {
    this.volume = val;
  }

  setSquelch(level) {
    this.squelchLevel = level;
  }

  getAnalyser() {
    return this.analyserNode;
  }

  getTimeDomainData() {
    if (!this.analyserNode) return null;
    const data = new Uint8Array(this.analyserNode.frequencyBinCount);
    this.analyserNode.getByteTimeDomainData(data);
    return data;
  }

  getFrequencyData() {
    if (!this.analyserNode) return null;
    const data = new Uint8Array(this.analyserNode.frequencyBinCount);
    this.analyserNode.getByteFrequencyData(data);
    return data;
  }

  /** Get buffer fill level as 0-1 */
  getBufferLevel() {
    return this._buffered / this._bufferSize;
  }

  // --- Internal ---

  _processAudio(e) {
    const output = e.outputBuffer.getChannelData(0);
    const len = output.length;

    // Calculate squelch threshold: map 0-100 to a power threshold
    // Exponential curve: low squelch values cut noise, high values cut weak signals
    // squelch=20 -> 0.02, squelch=50 -> 0.125, squelch=100 -> 0.5
    const sqThreshold = this.squelchLevel > 0
      ? Math.pow(this.squelchLevel / 100, 2) * 0.5
      : 0;

    // Compute RMS of upcoming audio to decide squelch
    let sumSq = 0;
    let peekCount = Math.min(len, this._buffered);
    let peekPos = this._readPos;
    for (let i = 0; i < peekCount; i++) {
      const s = this._ringBuffer[peekPos];
      sumSq += s * s;
      peekPos = (peekPos + 1) % this._bufferSize;
    }
    const instantRMS = peekCount > 0 ? Math.sqrt(sumSq / peekCount) : 0;

    // Smooth the RMS
    if (instantRMS > this.audioRMS) {
      this.audioRMS = instantRMS;
    } else {
      this.audioRMS = this.audioRMS * this._rmsDecay + instantRMS * (1 - this._rmsDecay);
    }

    // Determine squelch state
    const wasSquelched = this.isSquelched;
    this.isSquelched = this.squelchLevel > 0 && this.audioRMS < sqThreshold;

    if (wasSquelched !== this.isSquelched && this.onSquelchChange) {
      this.onSquelchChange(this.isSquelched, this.audioRMS, sqThreshold);
    }

    // Fill output from ring buffer
    for (let i = 0; i < len; i++) {
      if (this._buffered > 0) {
        let sample = this._ringBuffer[this._readPos];
        this._readPos = (this._readPos + 1) % this._bufferSize;
        this._buffered--;

        // Apply squelch gate
        if (this.isSquelched) {
          sample = 0;
        }

        output[i] = sample * this.volume;
      } else {
        output[i] = 0; // Buffer underrun - silence
      }
    }
  }

  _handleAudioData(arrayBuffer) {
    if (!this._ringBuffer || !this.playing) return;

    const int16 = new Int16Array(arrayBuffer);

    for (let i = 0; i < int16.length; i++) {
      this._ringBuffer[this._writePos] = int16[i] / 32768;
      this._writePos = (this._writePos + 1) % this._bufferSize;
      this._buffered++;

      // If buffer overflows, advance read position (drop oldest)
      if (this._buffered >= this._bufferSize) {
        this._readPos = (this._readPos + 1) % this._bufferSize;
        this._buffered = this._bufferSize - 1;
      }
    }
  }

  _handleControlMessage(msg) {
    console.log('[Audio] Control message:', msg);
    if (this.onStatusChange) {
      this.onStatusChange(msg);
    }
  }

  _setupBackgroundAudio() {
    if (this._silentAudio) return;
    this._silentAudio = document.createElement('audio');
    this._silentAudio.loop = true;
    this._silentAudio.setAttribute('playsinline', '');
    const silence = this._generateSilentWav(1);
    this._silentAudio.src = URL.createObjectURL(
      new Blob([silence], { type: 'audio/wav' })
    );
  }

  _startBackgroundAudio() {
    if (this._silentAudio) this._silentAudio.play().catch(() => {});
  }

  _stopBackgroundAudio() {
    if (this._silentAudio) this._silentAudio.pause();
  }

  _generateSilentWav(durationSec) {
    const sr = 8000, ns = sr * durationSec;
    const buf = new ArrayBuffer(44 + ns * 2);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0,'RIFF'); v.setUint32(4,36+ns*2,true); w(8,'WAVE'); w(12,'fmt ');
    v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
    v.setUint32(24,sr,true); v.setUint32(28,sr*2,true); v.setUint16(32,2,true);
    v.setUint16(34,16,true); w(36,'data'); v.setUint32(40,ns*2,true);
    return buf;
  }

  _notifyStatus() {
    if (this.onStatusChange) {
      this.onStatusChange({
        event: 'status',
        playing: this.playing,
        connected: this.ws && this.ws.readyState === WebSocket.OPEN,
      });
    }
  }
}

window.audioEngine = new AudioEngine();

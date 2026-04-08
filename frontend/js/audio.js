/**
 * Audio engine - handles WebSocket audio streaming and Web Audio API playback.
 * Supports background playback on mobile via silent audio element trick.
 */
class AudioEngine {
  constructor() {
    this.audioCtx = null;
    this.gainNode = null;
    this.analyserNode = null;
    this.ws = null;
    this.playing = false;
    this.volume = 0.8;
    this.sampleRate = 48000;
    this.bufferQueue = [];
    this.isProcessing = false;
    this.nextStartTime = 0;

    // Silent audio element to keep mobile audio session alive
    this._silentAudio = null;

    // Callbacks
    this.onStatusChange = null;
  }

  /**
   * Initialize the Web Audio API context.
   * Must be called from a user gesture on mobile.
   */
  init() {
    if (this.audioCtx) return;

    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: this.sampleRate,
    });

    this.gainNode = this.audioCtx.createGain();
    this.gainNode.gain.value = this.volume;

    this.analyserNode = this.audioCtx.createAnalyser();
    this.analyserNode.fftSize = 2048;
    this.analyserNode.smoothingTimeConstant = 0.8;

    this.gainNode.connect(this.analyserNode);
    this.analyserNode.connect(this.audioCtx.destination);

    this._setupBackgroundAudio();
  }

  /**
   * Connect to the WebSocket audio stream.
   */
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
        } catch (err) {
          // ignore
        }
      }
    };

    this.ws.onclose = () => {
      console.log('[Audio] WebSocket disconnected');
      this._notifyStatus();
      // Reconnect after delay
      setTimeout(() => {
        if (this.playing) this.connect();
      }, 2000);
    };

    this.ws.onerror = (e) => {
      console.error('[Audio] WebSocket error', e);
    };
  }

  /**
   * Send a control command via WebSocket.
   */
  send(cmd) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd));
    }
  }

  /**
   * Start audio playback.
   */
  play() {
    this.init();
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    this.playing = true;
    this.nextStartTime = 0;
    this.connect();
    this._startBackgroundAudio();
    this._notifyStatus();
  }

  /**
   * Stop audio playback.
   */
  stop() {
    this.playing = false;
    this.bufferQueue = [];
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._stopBackgroundAudio();
    this._notifyStatus();
  }

  /**
   * Set volume (0 to 1).
   */
  setVolume(val) {
    this.volume = val;
    if (this.gainNode) {
      this.gainNode.gain.value = val;
    }
  }

  /**
   * Get analyser node for visualization.
   */
  getAnalyser() {
    return this.analyserNode;
  }

  /**
   * Get time domain data for waveform.
   */
  getTimeDomainData() {
    if (!this.analyserNode) return null;
    const data = new Uint8Array(this.analyserNode.frequencyBinCount);
    this.analyserNode.getByteTimeDomainData(data);
    return data;
  }

  /**
   * Get frequency data for FFT display.
   */
  getFrequencyData() {
    if (!this.analyserNode) return null;
    const data = new Uint8Array(this.analyserNode.frequencyBinCount);
    this.analyserNode.getByteFrequencyData(data);
    return data;
  }

  // --- Internal ---

  _handleAudioData(arrayBuffer) {
    if (!this.audioCtx || !this.playing) return;

    // Convert Int16 PCM to Float32
    const int16 = new Int16Array(arrayBuffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    // Create audio buffer and schedule playback
    const audioBuffer = this.audioCtx.createBuffer(1, float32.length, this.sampleRate);
    audioBuffer.getChannelData(0).set(float32);

    const source = this.audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.gainNode);

    const currentTime = this.audioCtx.currentTime;
    if (this.nextStartTime < currentTime) {
      // We've fallen behind, reset timing
      this.nextStartTime = currentTime + 0.02; // Small buffer
    }

    source.start(this.nextStartTime);
    this.nextStartTime += audioBuffer.duration;
  }

  _handleControlMessage(msg) {
    console.log('[Audio] Control message:', msg);
    if (msg.event === 'tuned' && this.onStatusChange) {
      this.onStatusChange(msg);
    }
  }

  _setupBackgroundAudio() {
    // Create a silent audio element to maintain the audio session
    // on mobile browsers even when the screen is off
    if (this._silentAudio) return;

    this._silentAudio = document.createElement('audio');
    this._silentAudio.loop = true;
    this._silentAudio.setAttribute('playsinline', '');

    // Generate a short silent WAV
    const silence = this._generateSilentWav(1); // 1 second
    this._silentAudio.src = URL.createObjectURL(
      new Blob([silence], { type: 'audio/wav' })
    );
  }

  _startBackgroundAudio() {
    if (this._silentAudio) {
      this._silentAudio.play().catch(() => {});
    }
  }

  _stopBackgroundAudio() {
    if (this._silentAudio) {
      this._silentAudio.pause();
    }
  }

  _generateSilentWav(durationSec) {
    const sampleRate = 8000;
    const numSamples = sampleRate * durationSec;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);

    // WAV header
    const writeString = (offset, str) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, numSamples * 2, true);
    // All zeros = silence

    return buffer;
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

// Global instance
window.audioEngine = new AudioEngine();

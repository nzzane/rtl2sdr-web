/**
 * Audio visualizer - renders waveform and FFT spectrum on canvas elements.
 * Shows squelch threshold line and dims waveform when signal is below squelch.
 */
class Visualizer {
  constructor() {
    this.waveformCanvas = null;
    this.fftCanvas = null;
    this.waveformCtx = null;
    this.fftCtx = null;
    this.animationId = null;
    this.running = false;

    // Colors
    this.waveColor = '#38bdf8';
    this.waveColorSquelched = '#334155';
    this.squelchLineColor = '#f59e0b';
    this.fftBarColor = '#38bdf8';
    this.fftPeakColor = '#0ea5e9';
    this.bgColor = '#0f172a';
    this.gridColor = '#1e293b';

    // FFT peaks (for peak hold display)
    this.fftPeaks = null;
    this.peakDecay = 0.98;

    // Squelch tracking
    this.squelchLevel = 0; // 0-100
    this.isSquelched = false;
    this._audioLevel = 0; // Running audio level (0-1)
    this._audioLevelDecay = 0.95;
  }

  init(waveformCanvasId, fftCanvasId) {
    this.waveformCanvas = document.getElementById(waveformCanvasId);
    this.fftCanvas = document.getElementById(fftCanvasId);

    if (this.waveformCanvas) {
      this.waveformCtx = this.waveformCanvas.getContext('2d');
      this._resizeCanvas(this.waveformCanvas);
    }
    if (this.fftCanvas) {
      this.fftCtx = this.fftCanvas.getContext('2d');
      this._resizeCanvas(this.fftCanvas);
    }

    window.addEventListener('resize', () => {
      if (this.waveformCanvas) this._resizeCanvas(this.waveformCanvas);
      if (this.fftCanvas) this._resizeCanvas(this.fftCanvas);
    });
  }

  setSquelch(level) {
    this.squelchLevel = level;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._animate();
  }

  stop() {
    this.running = false;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    if (this.waveformCtx) {
      this.waveformCtx.fillStyle = this.bgColor;
      this.waveformCtx.fillRect(0, 0, this.waveformCanvas.width, this.waveformCanvas.height);
    }
    if (this.fftCtx) {
      this.fftCtx.fillStyle = this.bgColor;
      this.fftCtx.fillRect(0, 0, this.fftCanvas.width, this.fftCanvas.height);
    }
  }

  _animate() {
    if (!this.running) return;

    const engine = window.audioEngine;

    if (this.waveformCtx) {
      const timeData = engine.getTimeDomainData();
      this._drawWaveform(timeData);
    }

    if (this.fftCtx) {
      const freqData = engine.getFrequencyData();
      this._drawFFT(freqData);
    }

    this.animationId = requestAnimationFrame(() => this._animate());
  }

  _drawWaveform(data) {
    const ctx = this.waveformCtx;
    const rect = this.waveformCanvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    // Background
    ctx.fillStyle = this.bgColor;
    ctx.fillRect(0, 0, w, h);

    // Center line
    ctx.strokeStyle = this.gridColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    // Compute audio level from the waveform data
    let rms = 0;
    if (data) {
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      rms = Math.sqrt(sum / data.length);
    }

    // Smooth the audio level
    if (rms > this._audioLevel) {
      this._audioLevel = rms;
    } else {
      this._audioLevel *= this._audioLevelDecay;
    }

    // Determine if signal is below squelch threshold
    // Map squelch (0-100) to amplitude threshold (0-0.5)
    const squelchThreshold = (this.squelchLevel / 100) * 0.5;
    this.isSquelched = this.squelchLevel > 0 && this._audioLevel < squelchThreshold;

    // Draw squelch threshold lines if squelch is active
    if (this.squelchLevel > 0) {
      const sqY = squelchThreshold * h; // Distance from center
      ctx.strokeStyle = this.squelchLineColor;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);

      // Upper threshold line
      ctx.beginPath();
      ctx.moveTo(0, h / 2 - sqY);
      ctx.lineTo(w, h / 2 - sqY);
      ctx.stroke();

      // Lower threshold line
      ctx.beginPath();
      ctx.moveTo(0, h / 2 + sqY);
      ctx.lineTo(w, h / 2 + sqY);
      ctx.stroke();

      ctx.setLineDash([]);

      // Label
      ctx.fillStyle = this.squelchLineColor;
      ctx.font = '9px monospace';
      ctx.textAlign = 'left';
      ctx.fillText('SQ', 2, h / 2 - sqY - 2);
    }

    if (!data) return;

    // Waveform - use dimmed color when squelched
    const color = this.isSquelched ? this.waveColorSquelched : this.waveColor;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    const sliceWidth = w / data.length;
    let x = 0;

    for (let i = 0; i < data.length; i++) {
      const v = data[i] / 128.0;
      const y = (v * h) / 2;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      x += sliceWidth;
    }

    ctx.stroke();

    // Glow effect (only when not squelched)
    if (!this.isSquelched) {
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.3)';
      ctx.lineWidth = 4;
      ctx.stroke();
    }

    // Audio level meter (thin bar on the right edge)
    const meterWidth = 3;
    const meterHeight = this._audioLevel * h;
    const meterColor = this.isSquelched ? '#475569' : '#22c55e';
    ctx.fillStyle = meterColor;
    ctx.fillRect(w - meterWidth, h / 2 - meterHeight / 2, meterWidth, meterHeight);
  }

  _drawFFT(data) {
    const ctx = this.fftCtx;
    const rect = this.fftCanvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    // Background
    ctx.fillStyle = this.bgColor;
    ctx.fillRect(0, 0, w, h);

    if (!data) return;

    // Initialize peaks array
    if (!this.fftPeaks || this.fftPeaks.length !== data.length) {
      this.fftPeaks = new Float32Array(data.length);
    }

    const barCount = Math.min(data.length, 128);
    const barWidth = w / barCount;
    const step = Math.floor(data.length / barCount);

    for (let i = 0; i < barCount; i++) {
      const idx = i * step;
      const value = data[idx] / 255;
      const barHeight = value * h;

      // Update peak
      if (value > this.fftPeaks[i]) {
        this.fftPeaks[i] = value;
      } else {
        this.fftPeaks[i] *= this.peakDecay;
      }

      // Draw bar with gradient
      const gradient = ctx.createLinearGradient(0, h, 0, h - barHeight);
      if (this.isSquelched) {
        gradient.addColorStop(0, 'rgba(71, 85, 105, 0.5)');
        gradient.addColorStop(1, 'rgba(71, 85, 105, 0.7)');
      } else {
        gradient.addColorStop(0, 'rgba(56, 189, 248, 0.6)');
        gradient.addColorStop(1, 'rgba(14, 165, 233, 0.9)');
      }
      ctx.fillStyle = gradient;
      ctx.fillRect(i * barWidth, h - barHeight, barWidth - 1, barHeight);

      // Draw peak line
      const peakY = h - this.fftPeaks[i] * h;
      ctx.fillStyle = this.isSquelched ? '#475569' : '#f1f5f9';
      ctx.fillRect(i * barWidth, peakY, barWidth - 1, 1);
    }
  }

  _resizeCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
  }
}

// Spectrum chart for the spectrum analyzer tab
class SpectrumChart {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.data = [];
  }

  draw(data) {
    if (!this.ctx) return;
    this.data = data;

    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const ctx = this.ctx;

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, w, h);

    if (!data || data.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No data - click Sweep to scan', w / 2, h / 2);
      return;
    }

    const freqs = data.map(d => d.freq);
    const powers = data.map(d => d.power);
    const minFreq = Math.min(...freqs);
    const maxFreq = Math.max(...freqs);
    const minPow = Math.min(...powers);
    const maxPow = Math.max(...powers);

    const margin = { top: 20, right: 10, bottom: 30, left: 45 };
    const plotW = w - margin.left - margin.right;
    const plotH = h - margin.top - margin.bottom;

    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;

    ctx.fillStyle = '#64748b';
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    const ySteps = 5;
    for (let i = 0; i <= ySteps; i++) {
      const y = margin.top + (plotH / ySteps) * i;
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(w - margin.right, y);
      ctx.stroke();
      const val = maxPow - ((maxPow - minPow) / ySteps) * i;
      ctx.fillText(val.toFixed(0) + ' dB', margin.left - 5, y + 3);
    }

    ctx.textAlign = 'center';
    const xSteps = Math.min(10, data.length);
    for (let i = 0; i <= xSteps; i++) {
      const x = margin.left + (plotW / xSteps) * i;
      const freq = minFreq + ((maxFreq - minFreq) / xSteps) * i;
      ctx.fillText((freq / 1e6).toFixed(1), x, h - 5);
    }

    ctx.beginPath();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5;

    const powRange = maxPow - minPow || 1;
    const freqRange = maxFreq - minFreq || 1;

    for (let i = 0; i < data.length; i++) {
      const x = margin.left + ((data[i].freq - minFreq) / freqRange) * plotW;
      const y = margin.top + plotH - ((data[i].power - minPow) / powRange) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    const lastX = margin.left + ((data[data.length - 1].freq - minFreq) / freqRange) * plotW;
    ctx.lineTo(lastX, margin.top + plotH);
    ctx.lineTo(margin.left, margin.top + plotH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(56, 189, 248, 0.1)';
    ctx.fill();

    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Frequency (MHz)', w / 2, h - 1);
  }
}

window.Visualizer = Visualizer;
window.SpectrumChart = SpectrumChart;

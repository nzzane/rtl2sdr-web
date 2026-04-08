/**
 * Audio visualizer - renders waveform and FFT spectrum on canvas elements.
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
    this.fftBarColor = '#38bdf8';
    this.fftPeakColor = '#0ea5e9';
    this.bgColor = '#0f172a';
    this.gridColor = '#1e293b';

    // FFT peaks (for peak hold display)
    this.fftPeaks = null;
    this.peakDecay = 0.98;
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

    // Handle resize
    window.addEventListener('resize', () => {
      if (this.waveformCanvas) this._resizeCanvas(this.waveformCanvas);
      if (this.fftCanvas) this._resizeCanvas(this.fftCanvas);
    });
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
    // Clear canvases
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
    const w = this.waveformCanvas.width;
    const h = this.waveformCanvas.height;

    // Background
    ctx.fillStyle = this.bgColor;
    ctx.fillRect(0, 0, w, h);

    // Grid lines
    ctx.strokeStyle = this.gridColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    if (!data) return;

    // Waveform
    ctx.strokeStyle = this.waveColor;
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

    // Glow effect
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.3)';
    ctx.lineWidth = 4;
    ctx.stroke();
  }

  _drawFFT(data) {
    const ctx = this.fftCtx;
    const w = this.fftCanvas.width;
    const h = this.fftCanvas.height;

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
      gradient.addColorStop(0, 'rgba(56, 189, 248, 0.6)');
      gradient.addColorStop(1, 'rgba(14, 165, 233, 0.9)');
      ctx.fillStyle = gradient;
      ctx.fillRect(i * barWidth, h - barHeight, barWidth - 1, barHeight);

      // Draw peak line
      const peakY = h - this.fftPeaks[i] * h;
      ctx.fillStyle = '#f1f5f9';
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
    // Reset canvas dimensions for CSS
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

    // Background
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, w, h);

    if (!data || data.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No data - click Sweep to scan', w / 2, h / 2);
      return;
    }

    // Find ranges
    const freqs = data.map(d => d.freq);
    const powers = data.map(d => d.power);
    const minFreq = Math.min(...freqs);
    const maxFreq = Math.max(...freqs);
    const minPow = Math.min(...powers);
    const maxPow = Math.max(...powers);

    const margin = { top: 20, right: 10, bottom: 30, left: 45 };
    const plotW = w - margin.left - margin.right;
    const plotH = h - margin.top - margin.bottom;

    // Grid
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;

    // Y axis grid & labels
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

    // X axis labels
    ctx.textAlign = 'center';
    const xSteps = Math.min(10, data.length);
    for (let i = 0; i <= xSteps; i++) {
      const x = margin.left + (plotW / xSteps) * i;
      const freq = minFreq + ((maxFreq - minFreq) / xSteps) * i;
      ctx.fillText((freq / 1e6).toFixed(1), x, h - 5);
    }

    // Plot line
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

    // Fill under the curve
    const lastX = margin.left + ((data[data.length - 1].freq - minFreq) / freqRange) * plotW;
    ctx.lineTo(lastX, margin.top + plotH);
    ctx.lineTo(margin.left, margin.top + plotH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(56, 189, 248, 0.1)';
    ctx.fill();

    // Axis labels
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Frequency (MHz)', w / 2, h - 1);
  }
}

window.Visualizer = Visualizer;
window.SpectrumChart = SpectrumChart;

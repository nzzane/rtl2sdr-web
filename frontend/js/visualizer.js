/**
 * Audio visualizer with SDR#-style draggable squelch line on FFT,
 * and click-to-tune spectrum chart.
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
    this.bgColor = '#0f172a';
    this.gridColor = '#1e293b';

    // FFT peaks
    this.fftPeaks = null;
    this.peakDecay = 0.98;

    // Draggable squelch line on FFT (SDR# style)
    this._squelchY = 0;          // Y position as fraction from bottom (0=bottom, 1=top)
    this._draggingSquelch = false;
    this.onSquelchDrag = null;   // callback(level 0-100)
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
      this._initSquelchDrag();
    }

    window.addEventListener('resize', () => {
      if (this.waveformCanvas) this._resizeCanvas(this.waveformCanvas);
      if (this.fftCanvas) this._resizeCanvas(this.fftCanvas);
    });
  }

  setSquelch(level) {
    // level 0-100 -> Y fraction 0-1
    this._squelchY = level / 100;
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
      const c = this.waveformCanvas.getBoundingClientRect();
      this.waveformCtx.fillStyle = this.bgColor;
      this.waveformCtx.fillRect(0, 0, c.width, c.height);
    }
    if (this.fftCtx) {
      const c = this.fftCanvas.getBoundingClientRect();
      this.fftCtx.fillStyle = this.bgColor;
      this.fftCtx.fillRect(0, 0, c.width, c.height);
    }
  }

  // --- Squelch drag on FFT canvas ---

  _initSquelchDrag() {
    const canvas = this.fftCanvas;
    if (!canvas) return;

    const getY = (e) => {
      const rect = canvas.getBoundingClientRect();
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      return Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
    };

    const onDown = (e) => {
      const y = getY(e);
      // Only start drag if near the squelch line (within 15% tolerance)
      if (Math.abs(y - this._squelchY) < 0.15 || this._squelchY === 0) {
        this._draggingSquelch = true;
        this._squelchY = y;
        canvas.style.cursor = 'ns-resize';
        if (this.onSquelchDrag) this.onSquelchDrag(Math.round(y * 100));
        e.preventDefault();
      }
    };

    const onMove = (e) => {
      if (!this._draggingSquelch) {
        // Show resize cursor when near the squelch line
        const y = getY(e);
        canvas.style.cursor = (Math.abs(y - this._squelchY) < 0.1 && this._squelchY > 0)
          ? 'ns-resize' : 'crosshair';
        return;
      }
      const y = getY(e);
      this._squelchY = y;
      if (this.onSquelchDrag) this.onSquelchDrag(Math.round(y * 100));
      e.preventDefault();
    };

    const onUp = () => {
      this._draggingSquelch = false;
      canvas.style.cursor = 'crosshair';
    };

    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('touchstart', onDown, { passive: false });
    canvas.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
  }

  // --- Animation ---

  _animate() {
    if (!this.running) return;
    const engine = window.audioEngine;

    if (this.waveformCtx) {
      this._drawWaveform(engine.getTimeDomainData(), engine);
    }
    if (this.fftCtx) {
      this._drawFFT(engine.getFrequencyData(), engine);
    }

    this.animationId = requestAnimationFrame(() => this._animate());
  }

  _drawWaveform(data, engine) {
    const ctx = this.waveformCtx;
    const rect = this.waveformCanvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;

    ctx.fillStyle = this.bgColor;
    ctx.fillRect(0, 0, w, h);

    // Center line
    ctx.strokeStyle = this.gridColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    const isSquelched = engine.isSquelched;
    const rms = engine.audioRMS;

    // Draw squelch threshold as envelope lines on the waveform
    if (engine.squelchLevel > 0) {
      const sqThreshold = Math.pow(engine.squelchLevel / 100, 2) * 0.1;
      // Map RMS threshold to waveform amplitude (rough: RMS * sqrt(2) ≈ peak)
      const peakAmp = Math.min(sqThreshold * 3, 0.5); // Scale for visibility
      const sqPixels = peakAmp * h;

      ctx.strokeStyle = this.squelchLineColor;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);

      ctx.beginPath();
      ctx.moveTo(0, h / 2 - sqPixels);
      ctx.lineTo(w, h / 2 - sqPixels);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(0, h / 2 + sqPixels);
      ctx.lineTo(w, h / 2 + sqPixels);
      ctx.stroke();

      ctx.setLineDash([]);

      ctx.fillStyle = this.squelchLineColor;
      ctx.font = '9px monospace';
      ctx.textAlign = 'left';
      ctx.fillText('SQ ' + engine.squelchLevel, 2, h / 2 - sqPixels - 2);
    }

    if (!data) return;

    // Waveform
    const color = isSquelched ? this.waveColorSquelched : this.waveColor;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    const sliceWidth = w / data.length;
    let x = 0;
    for (let i = 0; i < data.length; i++) {
      const y = (data[i] / 128.0) * h / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }
    ctx.stroke();

    if (!isSquelched) {
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.3)';
      ctx.lineWidth = 4;
      ctx.stroke();
    }

    // RMS level meter on right edge
    const meterW = 4;
    const meterH = Math.min(rms * 8, 1) * h; // Scale for visibility
    ctx.fillStyle = isSquelched ? '#475569' : '#22c55e';
    ctx.fillRect(w - meterW, h / 2 - meterH / 2, meterW, meterH);

    // Buffer level indicator (thin line at very bottom)
    const bufLevel = engine.getBufferLevel();
    const bufColor = bufLevel < 0.05 ? '#f43f5e' : bufLevel < 0.15 ? '#f59e0b' : '#334155';
    ctx.fillStyle = bufColor;
    ctx.fillRect(0, h - 2, w * bufLevel, 2);
  }

  _drawFFT(data, engine) {
    const ctx = this.fftCtx;
    const rect = this.fftCanvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;

    ctx.fillStyle = this.bgColor;
    ctx.fillRect(0, 0, w, h);

    if (!data) return;

    if (!this.fftPeaks || this.fftPeaks.length !== data.length) {
      this.fftPeaks = new Float32Array(data.length);
    }

    const isSquelched = engine.isSquelched;
    const barCount = Math.min(data.length, 128);
    const barWidth = w / barCount;
    const step = Math.floor(data.length / barCount);

    for (let i = 0; i < barCount; i++) {
      const value = data[i * step] / 255;
      const barHeight = value * h;

      if (value > this.fftPeaks[i]) this.fftPeaks[i] = value;
      else this.fftPeaks[i] *= this.peakDecay;

      const grad = ctx.createLinearGradient(0, h, 0, h - barHeight);
      if (isSquelched) {
        grad.addColorStop(0, 'rgba(71, 85, 105, 0.4)');
        grad.addColorStop(1, 'rgba(71, 85, 105, 0.6)');
      } else {
        grad.addColorStop(0, 'rgba(56, 189, 248, 0.6)');
        grad.addColorStop(1, 'rgba(14, 165, 233, 0.9)');
      }
      ctx.fillStyle = grad;
      ctx.fillRect(i * barWidth, h - barHeight, barWidth - 1, barHeight);

      ctx.fillStyle = isSquelched ? '#475569' : '#f1f5f9';
      ctx.fillRect(i * barWidth, h - this.fftPeaks[i] * h, barWidth - 1, 1);
    }

    // Draw squelch line (SDR# style - horizontal draggable line)
    if (this._squelchY > 0) {
      const sqLineY = h * (1 - this._squelchY);

      // Filled region below squelch line (muted zone)
      ctx.fillStyle = 'rgba(245, 158, 11, 0.08)';
      ctx.fillRect(0, sqLineY, w, h - sqLineY);

      // The squelch line itself
      ctx.strokeStyle = this.squelchLineColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, sqLineY);
      ctx.lineTo(w, sqLineY);
      ctx.stroke();

      // Squelch label
      ctx.fillStyle = this.squelchLineColor;
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'right';
      ctx.fillText('SQ ' + Math.round(this._squelchY * 100), w - 4, sqLineY - 3);

      // Small drag handle triangles
      ctx.fillStyle = this.squelchLineColor;
      ctx.beginPath();
      ctx.moveTo(0, sqLineY - 4);
      ctx.lineTo(6, sqLineY);
      ctx.lineTo(0, sqLineY + 4);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(w, sqLineY - 4);
      ctx.lineTo(w - 6, sqLineY);
      ctx.lineTo(w, sqLineY + 4);
      ctx.fill();
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


/**
 * Spectrum chart - click-to-tune, shows tuned freq marker, auto-sweep.
 */
class SpectrumChart {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.data = [];
    this.margin = { top: 20, right: 10, bottom: 30, left: 45 };

    // Click-to-tune
    this.onFreqClick = null; // callback(freqHz)
    this.tunedFreq = null;   // Hz - shows as red marker

    // Cached range for click mapping
    this._minFreq = 0;
    this._maxFreq = 0;

    if (this.canvas) {
      this.canvas.style.cursor = 'crosshair';
      this.canvas.addEventListener('click', (e) => this._handleClick(e));

      // Tooltip on hover
      this.canvas.addEventListener('mousemove', (e) => this._handleHover(e));
      this.canvas.addEventListener('mouseleave', () => {
        this.canvas.title = '';
      });
    }
  }

  setTunedFreq(hz) {
    this.tunedFreq = hz;
    // Redraw if we have data
    if (this.data.length > 0) this.draw(this.data);
  }

  draw(data) {
    if (!this.ctx) return;
    this.data = data;

    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);

    const w = rect.width, h = rect.height;
    const ctx = this.ctx;
    const m = this.margin;

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, w, h);

    if (!data || data.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Click Sweep to scan the spectrum, then click a signal to tune', w / 2, h / 2);
      return;
    }

    const freqs = data.map(d => d.freq);
    const powers = data.map(d => d.power);
    const minFreq = Math.min(...freqs);
    const maxFreq = Math.max(...freqs);
    const minPow = Math.min(...powers);
    const maxPow = Math.max(...powers);

    this._minFreq = minFreq;
    this._maxFreq = maxFreq;

    const plotW = w - m.left - m.right;
    const plotH = h - m.top - m.bottom;
    const powRange = maxPow - minPow || 1;
    const freqRange = maxFreq - minFreq || 1;

    // Grid
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748b';
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';

    const ySteps = 5;
    for (let i = 0; i <= ySteps; i++) {
      const y = m.top + (plotH / ySteps) * i;
      ctx.beginPath(); ctx.moveTo(m.left, y); ctx.lineTo(w - m.right, y); ctx.stroke();
      const val = maxPow - (powRange / ySteps) * i;
      ctx.fillText(val.toFixed(0) + ' dB', m.left - 5, y + 3);
    }

    ctx.textAlign = 'center';
    const xSteps = Math.min(10, data.length);
    for (let i = 0; i <= xSteps; i++) {
      const x = m.left + (plotW / xSteps) * i;
      const freq = minFreq + (freqRange / xSteps) * i;
      ctx.fillText((freq / 1e6).toFixed(2), x, h - 5);
    }

    // Spectrum fill
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = m.left + ((data[i].freq - minFreq) / freqRange) * plotW;
      const y = m.top + plotH - ((data[i].power - minPow) / powRange) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    // Close for fill
    const lastX = m.left + ((data[data.length - 1].freq - minFreq) / freqRange) * plotW;
    ctx.lineTo(lastX, m.top + plotH);
    ctx.lineTo(m.left, m.top + plotH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(56, 189, 248, 0.15)';
    ctx.fill();

    // Spectrum line
    ctx.beginPath();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < data.length; i++) {
      const x = m.left + ((data[i].freq - minFreq) / freqRange) * plotW;
      const y = m.top + plotH - ((data[i].power - minPow) / powRange) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Tuned frequency marker (red vertical line like SDR#)
    if (this.tunedFreq && this.tunedFreq >= minFreq && this.tunedFreq <= maxFreq) {
      const tx = m.left + ((this.tunedFreq - minFreq) / freqRange) * plotW;

      // Bandwidth shading (~200kHz for WBFM, ~12.5kHz for NFM)
      const bwHz = 100000; // Generic display bandwidth
      const bwPx = (bwHz / freqRange) * plotW;
      ctx.fillStyle = 'rgba(239, 68, 68, 0.12)';
      ctx.fillRect(tx - bwPx / 2, m.top, bwPx, plotH);

      // Center line
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(tx, m.top);
      ctx.lineTo(tx, m.top + plotH);
      ctx.stroke();

      // Frequency label
      ctx.fillStyle = '#ef4444';
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText((this.tunedFreq / 1e6).toFixed(3) + ' MHz', tx, m.top - 5);
    }

    // Axis label
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Frequency (MHz) - Click to tune', w / 2, h - 1);
  }

  _handleClick(e) {
    if (!this.data.length || !this.onFreqClick) return;

    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const x = (e.clientX - rect.left);
    const plotW = rect.width - this.margin.left - this.margin.right;

    // Map click X to frequency
    const frac = (x - this.margin.left) / plotW;
    if (frac < 0 || frac > 1) return;

    const freqRange = this._maxFreq - this._minFreq;
    const freq = this._minFreq + frac * freqRange;

    this.onFreqClick(Math.round(freq));
  }

  _handleHover(e) {
    if (!this.data.length) return;

    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const plotW = rect.width - this.margin.left - this.margin.right;
    const frac = (x - this.margin.left) / plotW;
    if (frac < 0 || frac > 1) { this.canvas.title = ''; return; }

    const freq = this._minFreq + frac * (this._maxFreq - this._minFreq);
    this.canvas.title = (freq / 1e6).toFixed(3) + ' MHz - Click to tune';
  }
}

window.Visualizer = Visualizer;
window.SpectrumChart = SpectrumChart;

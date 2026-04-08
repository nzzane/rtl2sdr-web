/**
 * RTL-SDR Web UI - Main Application
 */
(function () {
  'use strict';

  // --- State ---
  let presets = { channels: [], groups: [] };
  let activeChannelId = null;
  let isPlaying = false;
  let currentSquelch = 0;

  const audio = window.audioEngine;
  const viz = new Visualizer();
  const spectrumChart = new SpectrumChart('spectrum-canvas');

  // --- Tag color map ---
  const TAG_COLORS = {
    'aviation':   'tag-aviation',
    'marine':     'tag-marine',
    'amateur':    'tag-amateur',
    'cb':         'tag-cb',
    'uhf-cb':     'tag-uhf-cb',
    'emergency':  'tag-emergency',
    'broadcast':  'tag-broadcast',
    'wellington': 'tag-wellington',
    'weather':    'tag-weather',
    'utility':    'tag-utility',
    'repeater':   'tag-repeater',
    'data':       'tag-data',
    'space':      'tag-space',
    '2m':         'tag-2m',
    '70cm':       'tag-70cm',
    'custom':     'tag-custom',
  };

  function getTagClass(tag) {
    return TAG_COLORS[tag] || '';
  }

  // --- Helpers ---
  function formatFreq(hz) {
    const mhz = hz / 1e6;
    if (mhz >= 1000) return mhz.toFixed(3) + ' MHz';
    if (mhz >= 1) return mhz.toFixed(mhz % 1 === 0 ? 1 : 3) + ' MHz';
    return (hz / 1e3).toFixed(1) + ' kHz';
  }

  async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch('/api/' + path, opts);
    return res.json();
  }

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return document.querySelectorAll(sel); }

  // --- Load Presets ---
  async function loadPresets() {
    presets = await api('GET', 'presets');
    renderChannels();
    renderScanGroups();
    renderManageChannels();
    renderManageGroups();
    renderGroupChannelCheckboxes();
    populateTagFilter();
  }

  // --- Channel List ---
  function renderChannels(filter = '', tagFilter = '') {
    const list = $('#channel-list');
    const search = filter.toLowerCase();

    const filtered = presets.channels.filter(ch => {
      if (search && !ch.name.toLowerCase().includes(search) &&
          !ch.description?.toLowerCase().includes(search) &&
          !(ch.tags || []).some(t => t.toLowerCase().includes(search))) {
        return false;
      }
      if (tagFilter && !(ch.tags || []).includes(tagFilter)) return false;
      return true;
    });

    list.innerHTML = filtered.map(ch => `
      <div class="channel-item ${ch.id === activeChannelId ? 'active' : ''}"
           data-id="${ch.id}" data-freq="${ch.freq}" data-mod="${ch.modulation}">
        <span class="ch-freq">${formatFreq(ch.freq)}</span>
        <div class="ch-info">
          <div class="ch-name">${esc(ch.name)}</div>
          <div class="ch-desc">${esc(ch.description || '')}</div>
        </div>
        <span class="ch-mod ${ch.modulation}">${ch.modulation}</span>
        <div class="ch-tags">
          ${(ch.tags || []).slice(0, 3).map(t => `<span class="tag ${getTagClass(t)}">${esc(t)}</span>`).join('')}
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.channel-item').forEach(el => {
      el.addEventListener('click', () => tuneChannel(parseInt(el.dataset.id)));
    });
  }

  function populateTagFilter() {
    const tags = new Set();
    presets.channels.forEach(ch => (ch.tags || []).forEach(t => tags.add(t)));
    const select = $('#channel-filter-tag');
    select.innerHTML = '<option value="">All tags</option>' +
      [...tags].sort().map(t => `<option value="${t}">${t}</option>`).join('');
  }

  // --- Tune Channel ---
  async function tuneChannel(channelId) {
    const ch = presets.channels.find(c => c.id === channelId);
    if (!ch) return;

    activeChannelId = channelId;

    audio.init();
    if (!audio.playing) {
      audio.play();
    }
    isPlaying = true;
    updatePlayButton();
    viz.start();

    audio.send({
      cmd: 'tune',
      freq: ch.freq,
      modulation: ch.modulation,
    });

    updateFreqDisplay(ch.freq, ch.name);
    updateStatus('active', 'Tuning...');
    renderChannels($('#channel-search').value, $('#channel-filter-tag').value);
  }

  // --- Manual Tune ---
  async function manualTune() {
    const freqMhz = parseFloat($('#manual-freq').value);
    if (isNaN(freqMhz) || freqMhz <= 0) return;

    const freqHz = Math.round(freqMhz * 1e6);
    const mod = $('#manual-mod').value;
    const squelch = parseInt($('#manual-squelch').value);
    const gain = $('#manual-gain').value;
    const bw = $('#manual-bw').value ? parseInt($('#manual-bw').value) * 1000 : null;
    const ppm = parseInt($('#manual-ppm').value) || 0;

    activeChannelId = null;

    // Sync manual squelch to global (client-side only)
    currentSquelch = squelch;
    $('#global-squelch').value = squelch;
    $('#global-squelch-val').textContent = squelch;
    audio.setSquelch(squelch);
    viz.setSquelch(squelch);

    audio.init();
    if (!audio.playing) {
      audio.play();
    }
    isPlaying = true;
    updatePlayButton();
    viz.start();

    audio.send({
      cmd: 'tune',
      freq: freqHz,
      modulation: mod,
      gain: gain,
      bandwidth: bw,
      ppm: ppm,
    });

    updateFreqDisplay(freqHz, 'Manual: ' + mod.toUpperCase());
    updateStatus('active', 'Tuning...');
    renderChannels($('#channel-search').value, $('#channel-filter-tag').value);
  }

  // --- Global Squelch Update (client-side only) ---
  function updateGlobalSquelch(val) {
    currentSquelch = val;
    $('#global-squelch-val').textContent = val;

    // Client-side squelch - no server restart needed
    audio.setSquelch(val);
    viz.setSquelch(val);

    // Sync to manual tab
    $('#manual-squelch').value = val;
    $('#manual-squelch-val').textContent = val;
  }

  // --- Scan ---
  async function startScan() {
    const groupId = parseInt($('#scan-group-select').value);
    const group = presets.groups.find(g => g.id === groupId);
    if (!group) return;

    const channels = group.channel_ids
      .map(id => presets.channels.find(c => c.id === id))
      .filter(Boolean);

    if (channels.length === 0) return;

    const squelch = parseInt($('#scan-squelch').value);
    const dwell = parseFloat($('#scan-dwell').value);

    audio.init();
    if (!audio.playing) {
      audio.play();
    }
    isPlaying = true;
    updatePlayButton();
    viz.start();

    renderScanChannels(channels);

    await api('POST', 'scan', {
      frequencies: channels.map(c => c.freq),
      modulation: group.modulation || 'fm',
      squelch: squelch,
      dwell_time: dwell,
    });

    $('#btn-scan-start').disabled = true;
    $('#btn-scan-stop').disabled = false;
    updateStatus('scanning', 'Scanning');
  }

  async function stopScan() {
    await api('POST', 'scan/stop');
    $('#btn-scan-start').disabled = false;
    $('#btn-scan-stop').disabled = true;
    updateStatus('active', sdr_isActive() ? 'Receiving' : 'Idle');
  }

  function sdr_isActive() {
    return audio.playing && audio.ws && audio.ws.readyState === WebSocket.OPEN;
  }

  function renderScanGroups() {
    const select = $('#scan-group-select');
    select.innerHTML = presets.groups.map(g =>
      `<option value="${g.id}">${esc(g.name)} (${g.channel_ids.length} ch)</option>`
    ).join('');
  }

  function renderScanChannels(channels) {
    const container = $('#scan-channel-list');
    container.innerHTML = channels.map((ch, i) =>
      `<span class="scan-ch-pill" data-index="${i}">${formatFreq(ch.freq)}</span>`
    ).join('');
  }

  // --- Stop All ---
  async function stopAll() {
    audio.send({ cmd: 'stop' });
    audio.stop();
    isPlaying = false;
    activeChannelId = null;
    updatePlayButton();
    viz.stop();
    updateFreqDisplay(null);
    updateStatus('', 'Idle');
    updateSDRStatus({ state: 'idle', error: null });
    renderChannels($('#channel-search').value, $('#channel-filter-tag').value);
    $('#btn-scan-start').disabled = false;
    $('#btn-scan-stop').disabled = true;
  }

  // --- Spectrum Sweep ---
  async function spectrumSweep() {
    const startMhz = parseFloat($('#spectrum-start').value);
    const endMhz = parseFloat($('#spectrum-end').value);
    const binKhz = parseInt($('#spectrum-bin').value);

    if (isNaN(startMhz) || isNaN(endMhz) || startMhz >= endMhz) return;

    $('#btn-spectrum-sweep').disabled = true;
    $('#btn-spectrum-sweep').textContent = 'Sweeping...';

    try {
      const result = await api('POST', 'spectrum', {
        start: Math.round(startMhz * 1e6),
        stop: Math.round(endMhz * 1e6),
        bin_size: binKhz * 1000,
      });
      spectrumChart.draw(result.data || []);
    } finally {
      $('#btn-spectrum-sweep').disabled = false;
      $('#btn-spectrum-sweep').textContent = 'Sweep';
    }
  }

  // --- Channel Management ---
  async function addChannel() {
    const name = $('#add-ch-name').value.trim();
    const freqMhz = parseFloat($('#add-ch-freq').value);
    if (!name || isNaN(freqMhz)) return;

    await api('POST', 'presets/channel', {
      name: name,
      freq: Math.round(freqMhz * 1e6),
      modulation: $('#add-ch-mod').value,
      description: $('#add-ch-desc').value.trim(),
      tags: $('#add-ch-tags').value.split(',').map(t => t.trim()).filter(Boolean),
    });

    $('#add-ch-name').value = '';
    $('#add-ch-freq').value = '';
    $('#add-ch-desc').value = '';
    $('#add-ch-tags').value = '';

    await loadPresets();
  }

  async function addGroup() {
    const name = $('#add-grp-name').value.trim();
    if (!name) return;

    const checkedIds = [];
    $$('#add-grp-channels input:checked').forEach(cb => {
      checkedIds.push(parseInt(cb.value));
    });

    if (checkedIds.length === 0) return;

    await api('POST', 'presets/group', {
      name: name,
      description: $('#add-grp-desc').value.trim(),
      modulation: $('#add-grp-mod').value,
      channel_ids: checkedIds,
    });

    $('#add-grp-name').value = '';
    $('#add-grp-desc').value = '';
    await loadPresets();
  }

  async function deleteChannel(id) {
    if (!confirm('Delete this channel?')) return;
    await api('DELETE', 'presets/channel/' + id);
    await loadPresets();
  }

  async function deleteGroup(id) {
    if (!confirm('Delete this group?')) return;
    await api('DELETE', 'presets/group/' + id);
    await loadPresets();
  }

  function editChannel(id) {
    const ch = presets.channels.find(c => c.id === id);
    if (!ch) return;

    $('#edit-ch-id').value = ch.id;
    $('#edit-ch-name').value = ch.name;
    $('#edit-ch-freq').value = ch.freq / 1e6;
    $('#edit-ch-mod').value = ch.modulation;
    $('#edit-ch-desc').value = ch.description || '';
    $('#edit-ch-tags').value = (ch.tags || []).join(', ');

    $('#modal-edit-channel').style.display = '';
  }

  async function saveEditChannel() {
    const id = parseInt($('#edit-ch-id').value);
    await api('PUT', 'presets/channel/' + id, {
      name: $('#edit-ch-name').value.trim(),
      freq: Math.round(parseFloat($('#edit-ch-freq').value) * 1e6),
      modulation: $('#edit-ch-mod').value,
      description: $('#edit-ch-desc').value.trim(),
      tags: $('#edit-ch-tags').value.split(',').map(t => t.trim()).filter(Boolean),
    });

    $('#modal-edit-channel').style.display = 'none';
    await loadPresets();
  }

  // --- Save Manual as Preset ---
  async function saveManualAsPreset() {
    const freqMhz = parseFloat($('#manual-freq').value);
    if (isNaN(freqMhz) || freqMhz <= 0) return;

    const name = prompt('Channel name:', `${freqMhz} MHz`);
    if (!name) return;

    await api('POST', 'presets/channel', {
      name: name,
      freq: Math.round(freqMhz * 1e6),
      modulation: $('#manual-mod').value,
      description: 'Manually saved',
      tags: ['custom'],
    });

    await loadPresets();
  }

  // --- Render Management Lists ---
  function renderManageChannels() {
    const list = $('#manage-channel-list');
    list.innerHTML = presets.channels.map(ch => `
      <div class="manage-item">
        <div class="manage-item-info">
          <div class="manage-item-name">${esc(ch.name)}</div>
          <div class="manage-item-detail">${formatFreq(ch.freq)} - ${ch.modulation.toUpperCase()}</div>
        </div>
        <div class="manage-item-actions">
          <button class="btn btn-sm btn-secondary" onclick="window._editChannel(${ch.id})">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="window._deleteChannel(${ch.id})">Del</button>
        </div>
      </div>
    `).join('');
  }

  function renderManageGroups() {
    const list = $('#manage-group-list');
    list.innerHTML = presets.groups.map(g => `
      <div class="manage-item">
        <div class="manage-item-info">
          <div class="manage-item-name">${esc(g.name)}</div>
          <div class="manage-item-detail">${g.channel_ids.length} channels - ${g.modulation?.toUpperCase() || 'FM'}</div>
        </div>
        <div class="manage-item-actions">
          <button class="btn btn-sm btn-danger" onclick="window._deleteGroup(${g.id})">Del</button>
        </div>
      </div>
    `).join('');
  }

  function renderGroupChannelCheckboxes() {
    const container = $('#add-grp-channels');
    container.innerHTML = presets.channels.map(ch => `
      <label>
        <input type="checkbox" value="${ch.id}">
        ${esc(ch.name)} (${formatFreq(ch.freq)})
      </label>
    `).join('');
  }

  // --- UI Updates ---
  function updateFreqDisplay(freqHz, label) {
    $('#current-freq').textContent = freqHz ? formatFreq(freqHz) : '---.--- MHz';
    $('#current-label').textContent = label || 'Not tuned';
  }

  function updateStatus(state, text) {
    const dot = $('#status-dot');
    dot.className = 'status-dot ' + state;
    $('#status-text').textContent = text;
  }

  function updateSDRStatus(sdr) {
    if (!sdr) return;
    const badge = $('#sdr-state-badge');
    const detail = $('#sdr-detail');

    badge.textContent = sdr.state || 'IDLE';
    badge.className = 'sdr-state-badge ' + (sdr.state || 'idle');

    if (sdr.error) {
      detail.textContent = sdr.error;
      detail.className = 'sdr-detail error-text';
      updateStatus('error', 'Error');
    } else if (sdr.state === 'receiving') {
      const parts = [];
      if (sdr.modulation) parts.push(sdr.modulation.toUpperCase());
      if (sdr.gain && sdr.gain !== 'auto') parts.push('Gain: ' + sdr.gain + 'dB');
      else parts.push('Auto gain');
      detail.textContent = parts.join(' | ');
      detail.className = 'sdr-detail';
    } else if (sdr.state === 'starting') {
      detail.textContent = 'Starting rtl_fm process...';
      detail.className = 'sdr-detail';
    } else {
      detail.textContent = '';
      detail.className = 'sdr-detail';
    }
  }

  function updatePlayButton() {
    $('#icon-play').style.display = isPlaying ? 'none' : '';
    $('#icon-pause').style.display = isPlaying ? '' : 'none';
  }

  function esc(str) {
    const el = document.createElement('span');
    el.textContent = str || '';
    return el.innerHTML;
  }

  // --- Status WebSocket ---
  function connectStatusWs() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/status`);

    ws.onmessage = (e) => {
      try {
        const status = JSON.parse(e.data);

        // Update SDR status bar
        if (status.sdr) {
          updateSDRStatus(status.sdr);
        }

        if (status.scanning) {
          updateStatus('scanning', 'Scanning');
          if (status.current_freq) {
            $('#scan-current-freq').textContent = formatFreq(status.current_freq);
            updateFreqDisplay(status.current_freq, 'Scanning');
            if (status.scan_index !== null) {
              $('#scan-progress').textContent =
                `Channel ${status.scan_index + 1} of ${status.scan_total}`;
              $$('.scan-ch-pill').forEach((pill, i) => {
                pill.classList.toggle('active', i === status.scan_index);
              });
            }
          }
        } else if (status.streaming && (!status.sdr || status.sdr.state !== 'error')) {
          updateStatus('active', 'Receiving');
        } else if (!status.streaming && !status.scanning && isPlaying) {
          // Check if there's an error
          if (status.sdr && status.sdr.state === 'error') {
            updateStatus('error', 'Error');
          }
        }
      } catch (err) { /* ignore */ }
    };

    ws.onclose = () => {
      setTimeout(connectStatusWs, 3000);
    };
  }

  // --- Expose to inline handlers ---
  window._editChannel = editChannel;
  window._deleteChannel = deleteChannel;
  window._deleteGroup = deleteGroup;

  // --- Event Binding ---
  function bindEvents() {
    // Tabs
    $$('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        $$('.tab').forEach(t => t.classList.remove('active'));
        $$('.tab-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        $('#panel-' + tab.dataset.tab).classList.add('active');
      });
    });

    // Channel search/filter
    $('#channel-search').addEventListener('input', (e) => {
      renderChannels(e.target.value, $('#channel-filter-tag').value);
    });
    $('#channel-filter-tag').addEventListener('change', (e) => {
      renderChannels($('#channel-search').value, e.target.value);
    });

    // Manual controls
    $('#btn-manual-tune').addEventListener('click', manualTune);
    $('#btn-manual-stop').addEventListener('click', stopAll);
    $('#btn-manual-save').addEventListener('click', saveManualAsPreset);

    // Manual squelch display syncs to global
    $('#manual-squelch').addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      $('#manual-squelch-val').textContent = val;
      $('#global-squelch').value = val;
      updateGlobalSquelch(val);
    });
    $('#scan-squelch').addEventListener('input', (e) => {
      $('#scan-squelch-val').textContent = e.target.value;
    });

    // Global squelch control (status bar)
    $('#global-squelch').addEventListener('input', (e) => {
      updateGlobalSquelch(parseInt(e.target.value));
    });

    // Scan controls
    $('#btn-scan-start').addEventListener('click', startScan);
    $('#btn-scan-stop').addEventListener('click', stopScan);

    // Spectrum
    $('#btn-spectrum-sweep').addEventListener('click', spectrumSweep);

    // Channel management
    $('#btn-add-channel').addEventListener('click', addChannel);
    $('#btn-add-group').addEventListener('click', addGroup);

    // Edit modal
    $('#btn-edit-ch-save').addEventListener('click', saveEditChannel);
    $('#btn-edit-ch-cancel').addEventListener('click', () => {
      $('#modal-edit-channel').style.display = 'none';
    });
    $('#modal-edit-channel').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-overlay')) {
        $('#modal-edit-channel').style.display = 'none';
      }
    });

    // Play/Pause
    $('#btn-play-pause').addEventListener('click', () => {
      if (isPlaying) {
        stopAll();
      } else {
        audio.init();
        audio.play();
        isPlaying = true;
        updatePlayButton();
        viz.start();
      }
    });

    // Volume
    $('#volume').addEventListener('input', (e) => {
      audio.setVolume(parseInt(e.target.value) / 100);
    });

    // Keyboard shortcut - Space to toggle play
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (isPlaying) stopAll();
        else { audio.init(); audio.play(); isPlaying = true; updatePlayButton(); viz.start(); }
      }
    });
  }

  // --- Spectrum click-to-tune ---
  function tuneFromSpectrum(freqHz) {
    const mod = $('#spectrum-tune-mod').value;
    activeChannelId = null;

    audio.init();
    if (!audio.playing) {
      audio.play();
    }
    isPlaying = true;
    updatePlayButton();
    viz.start();

    audio.send({
      cmd: 'tune',
      freq: freqHz,
      modulation: mod,
    });

    spectrumChart.setTunedFreq(freqHz);
    updateFreqDisplay(freqHz, 'Spectrum: ' + mod.toUpperCase());
    updateStatus('active', 'Tuning...');
    renderChannels($('#channel-search').value, $('#channel-filter-tag').value);
  }

  // --- Init ---
  async function init() {
    bindEvents();
    viz.init('waveform-canvas', 'fft-canvas');

    // Wire up SDR#-style squelch drag on FFT canvas
    viz.onSquelchDrag = (level) => {
      currentSquelch = level;
      $('#global-squelch').value = level;
      $('#global-squelch-val').textContent = level;
      $('#manual-squelch').value = level;
      $('#manual-squelch-val').textContent = level;
      audio.setSquelch(level);
    };

    // Wire up spectrum click-to-tune
    spectrumChart.onFreqClick = (freqHz) => {
      tuneFromSpectrum(freqHz);
    };

    // Squelch change callback for visual feedback
    audio.onSquelchChange = (isSquelched, rms, threshold) => {
      const indicator = $('#squelch-indicator');
      if (indicator) {
        indicator.textContent = isSquelched ? 'MUTED' : '';
        indicator.className = 'squelch-indicator' + (isSquelched ? ' active' : '');
      }
    };

    await loadPresets();
    connectStatusWs();

    // Check tool availability
    const status = await api('GET', 'status');
    if (status.tools) {
      const missing = Object.entries(status.tools)
        .filter(([, ok]) => !ok)
        .map(([name]) => name);
      if (missing.length > 0) {
        updateSDRStatus({
          state: 'error',
          error: 'Missing tools: ' + missing.join(', '),
        });
      }
    }
  }

  // Register service worker for PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.log('SW registration failed:', err);
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();

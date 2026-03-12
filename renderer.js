// System Monitor Overlay - Renderer Process
document.addEventListener('DOMContentLoaded', () => {
  const elements = {
    cpuLoad: document.getElementById('cpu-load'),
    cpuTemp: document.getElementById('cpu-temp'),
    cpuSpeed: document.getElementById('cpu-speed'),
    cpuBar: document.getElementById('cpu-bar'),

    gpuUtil: document.getElementById('gpu-util'),
    gpuTemp: document.getElementById('gpu-temp'),
    gpuVram: document.getElementById('gpu-vram'),
    gpuBar: document.getElementById('gpu-bar'),

    ramPercent: document.getElementById('ram-percent'),
    ramDetail: document.getElementById('ram-detail'),
    ramBar: document.getElementById('ram-bar'),

    diskPercent: document.getElementById('disk-percent'),
    diskDetail: document.getElementById('disk-detail'),
    diskBar: document.getElementById('disk-bar'),

    batterySection: document.getElementById('battery-section'),
    batteryPercent: document.getElementById('battery-percent'),
    batteryStatus: document.getElementById('battery-status'),
    batteryBar: document.getElementById('battery-bar'),

    pingValue: document.getElementById('ping-value'),
    pingStatus: document.getElementById('ping-status'),

    sessionSection: document.getElementById('session-section'),
    sessionTime: document.getElementById('session-time'),
    sessionStatus: document.getElementById('session-status'),

    setupNotice: document.getElementById('setup-warning'),

    uptime: document.getElementById('uptime')
  };

  // Get temperature status class
  function getTempClass(temp) {
    if (temp === null || temp === undefined) return '';
    if (temp < 60) return 'temp-safe';
    if (temp < 80) return 'temp-warning';
    return 'temp-danger';
  }

  // Get load status class
  function getLoadClass(percent) {
    if (percent < 60) return 'safe';
    if (percent < 85) return 'warning';
    return 'danger';
  }

  // Get bar status class
  function getBarClass(percent) {
    if (percent < 60) return '';
    if (percent < 85) return 'warning';
    return 'danger';
  }

  // Update metric value with animation
  function updateValue(element, value, suffix = '') {
    if (!element) return;
    const displayValue = value !== null && value !== undefined && value !== 'N/A' 
      ? `${value}${suffix}` 
      : '--' + suffix;
    
    if (element.textContent !== displayValue) {
      element.textContent = displayValue;
    }
  }

  // Update progress bar
  function updateBar(barElement, percent) {
    if (!barElement) return;
    const clampedPercent = Math.min(100, Math.max(0, percent || 0));
    barElement.style.width = `${clampedPercent}%`;
    
    // Remove old classes
    barElement.classList.remove('warning', 'danger');
    const barClass = getBarClass(clampedPercent);
    if (barClass) barElement.classList.add(barClass);
  }

  // Smooth UI Timer State
  let localSessionDuration = 0;
  let localSessionActive = false;
  let localTimerInterval = null;

  function updateSessionDOM(duration, isActive) {
      if (duration <= 0 && !isActive) {
          elements.sessionTime.textContent = '00:00:00';
          elements.sessionTime.className = 'metric-value';
          elements.sessionStatus.textContent = 'Oyun Bekleniyor';
          return;
      }
      
      const hours = String(Math.floor(duration / 3600)).padStart(2, '0');
      const minutes = String(Math.floor((duration % 3600) / 60)).padStart(2, '0');
      const seconds = String(duration % 60).padStart(2, '0');
      
      elements.sessionTime.textContent = `${hours}:${minutes}:${seconds}`;
      if (isActive) {
         elements.sessionTime.className = 'metric-value danger'; // Red/glow when active
         elements.sessionStatus.textContent = 'Oyun Algılandı (Kayıtta)';
      } else {
         elements.sessionTime.className = 'metric-value warning'; // Yellow when paused/finished
         elements.sessionStatus.textContent = 'Son Oturum Süresi';
      }
  }

  // Start local 1-second tick
  function ensureLocalTimer() {
      if (!localTimerInterval) {
          localTimerInterval = setInterval(() => {
              if (localSessionActive) {
                  localSessionDuration++;
                  updateSessionDOM(localSessionDuration, true);
              }
          }, 1000);
      }
  }
  ensureLocalTimer();

  // Listen for system data from main process
  window.systemAPI.onSystemData((data) => {
    if (!data) return;

    // ===== CPU =====
    if (data.cpu) {
      updateValue(elements.cpuLoad, data.cpu.load, '%');
      elements.cpuLoad.className = 'metric-value ' + getLoadClass(data.cpu.load);
      updateBar(elements.cpuBar, data.cpu.load);

      if (data.cpu.temperature !== null) {
        updateValue(elements.cpuTemp, data.cpu.temperature);
        elements.cpuTemp.className = getTempClass(data.cpu.temperature);
        if (elements.setupNotice) elements.setupNotice.style.display = 'none';
      } else {
        elements.cpuTemp.textContent = '--';
        if (elements.setupNotice) elements.setupNotice.style.display = 'block';
      }

      updateValue(elements.cpuSpeed, data.cpu.speed);
    }

    // ===== GPU =====
    if (data.gpu) {
      const gpuPercent = data.gpu.utilization !== null ? data.gpu.utilization : 0;
      updateValue(elements.gpuUtil, gpuPercent !== null ? gpuPercent : '--', gpuPercent !== null ? '%' : '');
      elements.gpuUtil.className = 'metric-value ' + getLoadClass(gpuPercent);
      updateBar(elements.gpuBar, gpuPercent);

      if (data.gpu.temperature !== null) {
        updateValue(elements.gpuTemp, data.gpu.temperature);
        elements.gpuTemp.className = getTempClass(data.gpu.temperature);
      } else {
        elements.gpuTemp.textContent = '--';
      }

      if (data.gpu.vramUsed !== null && data.gpu.vramTotal !== null) {
        elements.gpuVram.textContent = `${data.gpu.vramUsed}/${data.gpu.vramTotal}`;
      } else {
        elements.gpuVram.textContent = '--';
      }
    }

    // ===== RAM =====
    if (data.ram) {
      updateValue(elements.ramPercent, data.ram.percent, '%');
      elements.ramPercent.className = 'metric-value ' + getLoadClass(data.ram.percent);
      updateBar(elements.ramBar, data.ram.percent);
      elements.ramDetail.textContent = `${data.ram.used} / ${data.ram.total} GB`;
    }

    // ===== DISK =====
    if (data.disk) {
      updateValue(elements.diskPercent, data.disk.percent, '%');
      elements.diskPercent.className = 'metric-value ' + getLoadClass(data.disk.percent);
      updateBar(elements.diskBar, data.disk.percent);
      elements.diskDetail.textContent = `${data.disk.used} / ${data.disk.total} GB`;
    }

    // ===== BATTERY =====
    let batteryVisible = false;
    if (data.battery) {
      if (elements.batterySection.style.display !== 'flex') {
         elements.batterySection.style.display = 'flex'; // Unhide block
         batteryVisible = true;
      }
      updateValue(elements.batteryPercent, data.battery.percent, '%');
      updateBar(elements.batteryBar, data.battery.percent);
      
      let statusText = data.battery.isCharging ? '🔌 Fişe Takılı' : '🔋 Pilde';
      if (!data.battery.isCharging && data.battery.timeRemaining) {
          statusText += ` (${data.battery.timeRemaining} dk)`;
      }
      elements.batteryStatus.textContent = statusText;
    } else {
      if (elements.batterySection.style.display !== 'none') {
         elements.batterySection.style.display = 'none'; // Hide on desktop
         batteryVisible = false;
      }
    }
    
    // Auto-resize window logic based on content height
    if (window.systemAPI && window.systemAPI.resizeWindow) {
         window.systemAPI.resizeWindow(document.body.scrollHeight);
    }

    // ===== PING =====
    if (data.ping) {
      updateValue(elements.pingValue, data.ping.ms, ' ms');
      
      if (data.ping.status === 'online') {
         elements.pingValue.className = 'metric-value safe';
         elements.pingStatus.textContent = '🟢 Google DNS';
      } else {
         elements.pingValue.className = 'metric-value danger';
         elements.pingStatus.textContent = '🔴 Offline / Timeout';
      }
    }

    // ===== GAMING SESSION =====
    if (data.session) {
      if (!batteryVisible) {
          elements.sessionSection.style.display = 'flex'; // Only show if battery isn't taking up desktop space
      }
      
      // Update local tracking states with true backend data
      localSessionActive = data.session.isActive;
      
      // Prevent UI bouncing (only jump if backend is more than 2 seconds out of sync)
      if (Math.abs(localSessionDuration - data.session.durationSecs) > 2 || !localSessionActive) {
          localSessionDuration = data.session.durationSecs;
      }
      
      updateSessionDOM(localSessionDuration, localSessionActive);
    }

    // ===== UPTIME =====
    if (data.uptime) {
      elements.uptime.textContent = data.uptime;
    }
  });

  // Handle layout mode changes
  window.systemAPI.onLayoutChange((mode) => {
    const container = document.querySelector('.overlay-container');
    if (mode === 'horizontal') {
      container.classList.add('horizontal');
    } else {
      container.classList.remove('horizontal');
    }
  });

  // Handle position lock changes
  window.systemAPI.onLockChange((locked) => {
    const container = document.querySelector('.overlay-container');
    if (!locked) {
      container.classList.add('unlocked');
    } else {
      container.classList.remove('unlocked');
    }
  });

  // Remove loading state
  document.body.classList.remove('loading');
});

const si = require('systeminformation');
const os = require('os');
const { exec } = require('child_process');
const http = require('http');

class SystemMonitor {
  constructor() {
    this.interval = null;
    this.mediumInterval = null;
    this.slowInterval = null;

    // Cache for heavy WMI queries that cause PC stutter
    this.cachedSlowData = {
      cpuInfo: null,
      cpuTemp: null,
      gpuInfo: null,
      diskInfo: null,
      nvidiaData: null,
      isNvidiaGpu: null,
      batteryData: null,
      pingData: null
    };
    this.lastCpus = os.cpus();

    // Gaming Session Tracking
    this.gamingSession = {
      isActive: false,
      startTime: null,
      durationSecs: 0
    };
  }

  async start(callback, intervalMs = 3000) {
    // Collect all once
    await this.collectSlowData();
    await this.collectMediumData();

    // Tier 1: SLOW (Every 120s) - Static info
    this.slowInterval = setInterval(() => {
      this.collectSlowData().catch(e => { });
    }, 120000);

    // Tier 2: MEDIUM (Every 10s) - Temperatures and GPU stats
    this.mediumInterval = setInterval(() => {
      this.collectMediumData().catch(e => { });
    }, 10000);

    // Tier 3: FAST (Every 3s) - CPU load, RAM, Network
    this.interval = setInterval(async () => {
      try {
        const data = await this.collectData();
        callback(data);
      } catch (err) {
        console.error('Monitor data collection error:', err);
      }
    }, intervalMs);

    // Initial emit
    const data = await this.collectData();
    callback(data);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    if (this.mediumInterval) clearInterval(this.mediumInterval);
    if (this.slowInterval) clearInterval(this.slowInterval);
  }

  async collectSlowData() {
    try {
      const [cpu, graphics, fsSize, battery] = await Promise.all([
        si.cpu(),
        si.graphics(),
        si.fsSize(),
        si.battery()
      ]);

      this.cachedSlowData.cpuInfo = cpu;
      this.cachedSlowData.gpuInfo = graphics;
      this.cachedSlowData.diskInfo = fsSize;

      // Initialize battery with basic info if available
      this.cachedSlowData.batteryData = battery || null;

      // Detect if an NVIDIA GPU is present to avoid blind execution
      if (graphics && graphics.controllers) {
        this.cachedSlowData.isNvidiaGpu = graphics.controllers.some(
          g => g.vendor && g.vendor.toLowerCase().includes('nvidia')
        );
      }
    } catch (err) {
      console.error('Slow data collection failed:', err);
    }
  }

  async collectMediumData() {
    try {
      // First try lightweight LHM for temp and clocks to avoid heavy WMI query
      const trueOhmTemp = await this.getOhmTemp();
      let cpuTemp = { main: null };

      // Fallback to heavy si.cpuTemperature only if LHM fails
      if (trueOhmTemp === null) {
        try { cpuTemp = await si.cpuTemperature(); } catch (e) { }
      }

      // Medium weight: GPU metrics and updated battery/ping
      const [nvidiaData, batteryUpdate, pingUpdate] = await Promise.all([
        this.getNvidiaData(),
        si.battery(),
        this.getPingData()
      ]);

      this.cachedSlowData.cpuTemp = cpuTemp;
      this.cachedSlowData.nvidiaData = nvidiaData;
      this.cachedSlowData.batteryData = batteryUpdate || this.cachedSlowData.batteryData;
      this.cachedSlowData.pingData = pingUpdate;
      this.cachedSlowData.trueCpuTempOverride = trueOhmTemp;
    } catch (err) {
      console.error('Medium data collection failed:', err);
    }
  }

  async getNvidiaData() {
    return new Promise((resolve) => {
      if (this.cachedSlowData.isNvidiaGpu === false) {
        return resolve(null); // Abort for AMD/Intel GPUs immediately
      }

      // Combined query for temperature, memory, and utilization to minimize process spawns
      const cmd = '"C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe" --query-gpu=temperature.gpu,memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits';
      exec(cmd, (err, stdout) => {
        if (err || !stdout) resolve(null);
        else {
          const parts = stdout.split(',').map(s => s.trim());
          resolve({
            temp: parseInt(parts[0]) || null,
            vramUsed: parseInt(parts[1]) || null,
            vramTotal: parseInt(parts[2]) || null,
            utilization: parseInt(parts[3]) || 0
          });
        }
      });
    });
  }

  async getPingData() {
    return new Promise((resolve) => {
      // Fast single ping to Google DNS to check internet latency without freezing
      const cmd = process.platform === 'win32' ? 'ping 8.8.8.8 -n 1 -w 1000' : 'ping 8.8.8.8 -c 1 -W 1';
      exec(cmd, { timeout: 1500 }, (err, stdout) => {
        if (err || !stdout) {
          resolve({ status: 'offline', ms: 0 });
          return;
        }

        // Parse Windows ping output for 'time=XXms'
        const match = stdout.match(/time[=<]([0-9]+)ms/i);
        if (match && match[1]) {
          resolve({ status: 'online', ms: parseInt(match[1]) });
        } else {
          resolve({ status: 'offline', ms: 0 });
        }
      });
    });
  }

  async getWmiCpuClock() {
    return new Promise((resolve) => {
      // Bu komut Task Manager'ın kullandığı orjinal "PercentProcessorPerformance" formülüdür.
      const cmd = 'wmic path Win32_PerfFormattedData_Counters_ProcessorInformation get Name,PercentProcessorPerformance';
      exec(cmd, { timeout: 1500 }, (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const match = stdout.match(/_Total\s+(\d+)/);
        if (match) {
          let perf = parseInt(match[1]);
          let baseClock = os.cpus()[0].speed;
          let ghz = (baseClock * (perf / 100)) / 1000;
          resolve(ghz.toFixed(2));
        } else {
          resolve(null);
        }
      });
    });
  }

  async getOhmTemp() {
    return new Promise((resolve) => {
      const options = { hostname: '127.0.0.1', port: 8085, path: '/data.json', method: 'GET', timeout: 2000 };
      const req = http.request(options, (res) => {
        let rawData = '';
        res.on('data', (chunk) => { rawData += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(rawData);
            resolve(this.findLibreTemp(data));
          } catch (e) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    });
  }

  findLibreTemp(node) {
    if (!node) return null;
    if (node.Text && (node.Text === 'CPU Package' || node.Text === 'Core Average' || node.Text === 'Core Max') &&
      node.Value && node.Type === 'Temperature') {
      const match = node.Value.match(/([0-9.,]+)/);
      if (match) return Math.round(parseFloat(match[1].replace(',', '.')));
    }
    if (node.Children && node.Children.length > 0) {
      for (const child of node.Children) {
        const found = this.findLibreTemp(child);
        if (found !== null) return found;
      }
    }
    return null;
  }

  async getOhmClock() {
    return new Promise((resolve) => {
      const options = { hostname: '127.0.0.1', port: 8085, path: '/data.json', method: 'GET', timeout: 2000 };
      const req = http.request(options, (res) => {
        let rawData = '';
        res.on('data', (chunk) => { rawData += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(rawData);
            resolve(this.findLibreClock(data));
          } catch (e) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    });
  }

  findLibreClock(node) {
    if (!node) return null;

    // Yüksek CPU hızı değerini bul (Örn: "CPU Core #1")
    if (node.Type === 'Clock' && node.Text && (node.Text.startsWith('CPU Core') || node.Text.includes('Core #'))) {
      const match = node.Value.match(/([0-9.,]+)/);
      if (match) {
        const mhz = parseFloat(match[1].replace(',', '.'));
        return (mhz / 1000).toFixed(2); // Dışarı 2.79 GHz olarak çıkar
      }
    }

    // Ağaç yapısında derine in
    if (node.Children && node.Children.length > 0) {
      let maxClock = null;
      for (const child of node.Children) {
        const found = this.findLibreClock(child);
        if (found !== null) {
          if (maxClock === null || parseFloat(found) > parseFloat(maxClock)) {
            maxClock = found;
          }
        }
      }
      return maxClock;
    }
    return null;
  }

  calculateCpuLoad() {
    const cpus = os.cpus();
    let totalIdle = 0, totalTick = 0;

    for (let i = 0, len = cpus.length; i < len; i++) {
      const cpu = cpus[i];
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    }

    let lastTotalIdle = 0, lastTotalTick = 0;
    for (let i = 0, len = this.lastCpus.length; i < len; i++) {
      const cpu = this.lastCpus[i];
      for (const type in cpu.times) {
        lastTotalTick += cpu.times[type];
      }
      lastTotalIdle += cpu.times.idle;
    }

    const idleDifference = totalIdle - lastTotalIdle;
    const totalDifference = totalTick - lastTotalTick;
    const percentageCPU = 100 - ~~(100 * idleDifference / totalDifference);

    this.lastCpus = cpus;
    return percentageCPU;
  }

  async collectData() {
    try {
      // Only poll lightweight processes here (Zero WMI queries!)
      // Network stats are removed to ensure zero WMI overhead.

      const cpu = this.cachedSlowData.cpuInfo || {};
      const cpuTemp = this.cachedSlowData.cpuTemp || { main: null };
      const trueTemp = this.cachedSlowData.trueCpuTempOverride;
      const trueClock = this.cachedSlowData.trueCpuClockOverride;
      const graphics = this.cachedSlowData.gpuInfo || {};
      const fsSize = this.cachedSlowData.diskInfo || [];

      // Her 3 saniyede bir arkadan WMI hız sayacını ateşle (Lag yapmaması için await YOK! Yüzen promise)
      this.getWmiCpuClock().then(clock => {
        if (clock !== null) {
          this.cachedSlowData.trueCpuClockOverride = clock;
        }
      }).catch(() => { });

      // Calculate fallback native CPU Speed if WMI fails
      let nativeMaxSpeed = 0;
      const osCpus = os.cpus();
      for (let i = 0; i < osCpus.length; i++) {
        if (osCpus[i].speed > nativeMaxSpeed) {
          nativeMaxSpeed = osCpus[i].speed;
        }
      }
      const osSpeedGhz = (nativeMaxSpeed / 1000).toFixed(2);

      // CPU data
      const cpuData = {
        model: cpu.brand ? `${cpu.manufacturer} ${cpu.brand}` : 'CPU',
        cores: cpu.cores || osCpus.length,
        speed: trueClock !== null ? parseFloat(trueClock) : parseFloat(osSpeedGhz),
        load: this.calculateCpuLoad(),
        temperature: trueTemp !== null ? trueTemp : (cpuTemp.main || null)
      };

      // RAM data (Calculated instantly via native OS module without WMI)
      const totalMemBytes = os.totalmem();
      const freeMemBytes = os.freemem();
      const usedMemBytes = totalMemBytes - freeMemBytes;
      const memPercent = Math.round((usedMemBytes / totalMemBytes) * 100);

      const ramData = {
        total: (totalMemBytes / (1024 * 1024 * 1024)).toFixed(1),
        used: (usedMemBytes / (1024 * 1024 * 1024)).toFixed(1),
        percent: memPercent
      };

      // GPU data
      let gpuData = {
        model: 'GPU',
        temperature: null,
        utilization: null,
        vram: null,
        vramUsed: null,
        vramTotal: null
      };

      if (graphics.controllers && graphics.controllers.length > 0) {
        // Find a dedicated GPU if possible, else use first
        const gpu = graphics.controllers.find(g => g.vram > 1024) || graphics.controllers[0];
        const nData = this.cachedSlowData.nvidiaData || {};
        gpuData = {
          model: gpu.model || 'GPU',
          temperature: nData.temp || gpu.temperatureGpu || null,
          utilization: nData.utilization !== undefined ? nData.utilization : (gpu.utilizationGpu || null),
          vram: nData.vramTotal || (gpu.vram ? Math.round(gpu.vram) : null),
          vramUsed: nData.vramUsed || (gpu.memoryUsed ? Math.round(gpu.memoryUsed) : null),
          vramTotal: nData.vramTotal || (gpu.vram ? Math.round(gpu.vram) : null)
        };
      }

      // Disk data
      let diskData = { used: 0, total: 0, percent: 0 };
      if (fsSize && fsSize.length > 0) {
        // Find OS drive or first drive
        const mainDisk = fsSize.find(d => d.mount === 'C:') || fsSize.find(d => d.use > 0) || fsSize[0];
        diskData = {
          used: (mainDisk.used / (1024 * 1024 * 1024)).toFixed(0),
          total: (mainDisk.size / (1024 * 1024 * 1024)).toFixed(0),
          percent: Math.round(mainDisk.use || 0)
        };
      }

      // Battery (Laptop)
      let batteryInfo = null;
      if (this.cachedSlowData.batteryData && this.cachedSlowData.batteryData.hasBattery) {
        batteryInfo = {
          percent: this.cachedSlowData.batteryData.percent || 0,
          isCharging: this.cachedSlowData.batteryData.isCharging || false,
          timeRemaining: this.cachedSlowData.batteryData.timeRemaining || null
        };
      }

      // Ping
      const pingInfo = this.cachedSlowData.pingData || { status: 'offline', ms: 0 };

      // Gaming Session Logic
      // 500 MB VRAM veya %25 GPU yükü gerekiyor (OR - Minecraft OpenGL'de GPU util %0 gösteriyor)
      // Ayrıca bu durumun anlık bir zıplama (spike) veya açılış hatası olmaması için
      // 3 test boyunca (yaklaşık 9 saniye) KESİNTİSİZ devam etmesi gerekiyor.
      let isActuallyGaming = false;
      if ((gpuData.vramUsed && gpuData.vramUsed >= 500) || (gpuData.utilization && gpuData.utilization >= 25)) {
        isActuallyGaming = true;
      }

      // Sayacı güvenceye al
      if (isActuallyGaming) {
         this.gamingSession.consecutiveChecks = (this.gamingSession.consecutiveChecks || 0) + 1;
      } else {
         this.gamingSession.consecutiveChecks = 0;
      }

      // Sadece 3 kez üst üste teyit edildiyse oyun say!
      let isGaming = this.gamingSession.consecutiveChecks >= 3;

      if (isGaming) {
        if (!this.gamingSession.isActive) {
          this.gamingSession.isActive = true;
          this.gamingSession.startTime = Date.now();
          this.gamingSession.durationSecs = 0;
        } else {
          this.gamingSession.durationSecs = Math.floor((Date.now() - this.gamingSession.startTime) / 1000);
        }
      } else {
        // Eğer oyundan çıkılırsa sayacı beklemeye al (sarı renk gösterilecek)
        if (this.gamingSession.isActive) {
          this.gamingSession.isActive = false;
        }
      }

      // Uptime
      const uptimeSeconds = os.uptime();
      const uptimeHours = Math.floor(uptimeSeconds / 3600);
      const uptimeMinutes = Math.floor((uptimeSeconds % 3600) / 60);

      return {
        cpu: cpuData,
        ram: ramData,
        gpu: gpuData,
        disk: diskData,
        battery: batteryInfo,
        ping: pingInfo,
        session: this.gamingSession,
        uptime: `${uptimeHours}s ${uptimeMinutes}dk`,
        timestamp: Date.now()
      };
    } catch (err) {
      console.error('Data collection error:', err);
      return null;
    }
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B/s';
    const k = 1024;
    const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }
}

module.exports = SystemMonitor;

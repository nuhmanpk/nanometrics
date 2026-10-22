import si from 'systeminformation';
import { execFile } from 'child_process';

export interface SystemSnapshot {
  timestamp: number;
  cpu: {
    load: number;
    user: number;
    system: number;
    cores: number[];
    brand: string;
    speed: number;
    temperature: number | null;
    temperatureAvg: number | null;
  };
  memory: {
    percent: number;
    used: number;
    total: number;
    swapUsed: number;
    swapTotal: number;
  };
  uptime: number;
  network?: { iface: string; ip4: string; rxSec: number; txSec: number } | null;
  disk?: { mount: string; used: number; size: number; percent: number }[];
  battery?: { percent: number; charging: boolean; acConnected: boolean; timeRemaining: number | null } | null;
  gpu?: { model: string; vram: number | null; utilization: number | null }[];
  services?: ServiceStatus[];
}

export interface ServiceStatus {
  name: string;
  running: boolean;
  pids: number[];
  cpu: number;
  mem: number;
}

export interface SystemOptions {
  network: boolean;
  battery: boolean;
  gpu: boolean;
  disk: boolean;
  temperature: boolean;
  services: { label: string; query: string }[];
}

// Static or slow-changing data is cached so each tick stays cheap.
let cpuInfoCache: { brand: string; speed: number } | undefined;
let diskCache: { at: number; value: SystemSnapshot['disk'] } | undefined;
let gpuCache: { at: number; value: SystemSnapshot['gpu'] } | undefined;

let macTempCache: { at: number; value: { max: number; avg: number } | null } | undefined;
let macTempPending: Promise<void> | undefined;

const DISK_TTL = 30_000;
const MAC_TEMP_TTL = 5_000;

// Apple Silicon exposes SoC die sensors through IOHIDEventSystem. JXA can reach it without
// native modules or sudo; systeminformation's own path needs a native addon VS Code can't load.
const MAC_TEMP_SCRIPT = `
ObjC.import('Foundation');
ObjC.bindFunction('IOHIDEventSystemClientCreate', ['id', ['void*']]);
ObjC.bindFunction('IOHIDEventSystemClientSetMatching', ['int', ['id', 'id']]);
ObjC.bindFunction('IOHIDEventSystemClientCopyServices', ['id', ['id']]);
ObjC.bindFunction('IOHIDServiceClientCopyProperty', ['id', ['id', 'id']]);
ObjC.bindFunction('IOHIDServiceClientCopyEvent', ['id', ['id', 'long long', 'int', 'long long']]);
ObjC.bindFunction('IOHIDEventGetFloatValue', ['double', ['id', 'int']]);
const client = $.IOHIDEventSystemClientCreate(null);
$.IOHIDEventSystemClientSetMatching(client, $({ PrimaryUsagePage: 0xff00, PrimaryUsage: 5 }));
const services = $.IOHIDEventSystemClientCopyServices(client);
const out = [];
for (let i = 0; services && i < services.count; i++) {
  const s = services.objectAtIndex(i);
  const name = ObjC.unwrap($.IOHIDServiceClientCopyProperty(s, $('Product'))) || '';
  if (!/tdie/.test(name)) { continue; }
  const ev = $.IOHIDServiceClientCopyEvent(s, 15, 0, 0);
  if (!ev || ev.isNil()) { continue; }
  out.push($.IOHIDEventGetFloatValue(ev, 15 << 16));
}
JSON.stringify(out);
`;

function refreshMacTemperature(): Promise<void> {
  return new Promise(resolve => {
    execFile('osascript', ['-l', 'JavaScript', '-e', MAC_TEMP_SCRIPT], { timeout: 5000 }, (err, stdout) => {
      let value: { max: number; avg: number } | null = null;
      try {
        const temps = (JSON.parse(stdout) as number[]).filter(t => t > 0 && t < 150);
        if (!err && temps.length) {
          value = { max: Math.max(...temps), avg: temps.reduce((a, b) => a + b, 0) / temps.length };
        }
      } catch {
        // Intel Macs or locked-down systems: no die sensors.
      }
      macTempCache = { at: Date.now(), value };
      resolve();
    });
  });
}

/** Last known die temperature; refreshes in the background so ticks never wait on osascript. */
function macTemperature() {
  if ((!macTempCache || Date.now() - macTempCache.at > MAC_TEMP_TTL) && !macTempPending) {
    macTempPending = refreshMacTemperature().finally(() => { macTempPending = undefined; });
  }
  return macTempCache?.value ?? null;
}

const GPU_TTL = 15_000;

async function cpuInfo() {
  if (!cpuInfoCache) {
    const c = await si.cpu();
    cpuInfoCache = { brand: `${c.manufacturer} ${c.brand}`.trim(), speed: c.speed };
  }
  return cpuInfoCache;
}

async function networkInfo(): Promise<SystemSnapshot['network']> {
  const iface = await si.networkInterfaceDefault();
  const [stats, ifaces] = await Promise.all([si.networkStats(iface), si.networkInterfaces()]);
  const list = Array.isArray(ifaces) ? ifaces : [ifaces];
  const info = list.find(i => i.iface === iface);
  const s = stats[0];
  return {
    iface,
    ip4: info?.ip4 ?? '',
    rxSec: Math.max(0, s?.rx_sec ?? 0),
    txSec: Math.max(0, s?.tx_sec ?? 0)
  };
}

async function diskInfo(): Promise<SystemSnapshot['disk']> {
  if (diskCache && Date.now() - diskCache.at < DISK_TTL) {
    return diskCache.value;
  }
  const fs = await si.fsSize();
  const seen = new Set<string>();
  const value = fs
    .filter(d => d.size > 0 && d.type !== 'squashfs')
    .filter(d => !d.mount.startsWith('/System/Volumes/') || d.mount === '/System/Volumes/Data')
    .filter(d => !/^\/(Library\/Developer\/CoreSimulator|private\/var\/vm|snap|boot)(\/|$)/.test(d.mount))
    .filter(d => {
      // Collapse APFS volumes sharing one container.
      const key = `${d.size}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 4)
    .map(d => ({ mount: d.mount, used: d.used, size: d.size, percent: d.use }));
  diskCache = { at: Date.now(), value };
  return value;
}

async function batteryInfo(): Promise<SystemSnapshot['battery']> {
  const b = await si.battery();
  if (!b.hasBattery) {
    return null;
  }
  return {
    percent: b.percent,
    charging: b.isCharging,
    acConnected: b.acConnected,
    timeRemaining: b.timeRemaining > 0 ? b.timeRemaining : null
  };
}

async function gpuInfo(): Promise<SystemSnapshot['gpu']> {
  if (gpuCache && Date.now() - gpuCache.at < GPU_TTL) {
    return gpuCache.value;
  }
  const g = await si.graphics();
  const value = g.controllers.map(c => ({
    model: c.model || c.vendor || 'GPU',
    vram: c.vram ?? c.memoryTotal ?? null,
    utilization: c.utilizationGpu ?? null
  }));
  gpuCache = { at: Date.now(), value };
  return value;
}

async function servicesInfo(services: SystemOptions['services']): Promise<ServiceStatus[]> {
  if (services.length === 0) {
    return [];
  }
  const result = await si.services(services.map(s => s.query).join(','));
  return services.map(s => {
    const found = result.find(r => r.name === s.query);
    return {
      name: s.label,
      running: !!found?.running,
      pids: found?.pids ?? [],
      cpu: found?.cpu ?? 0,
      mem: found?.mem ?? 0
    };
  });
}

function settle<T>(p: Promise<T>): Promise<T | undefined> {
  return p.catch(() => undefined);
}

export async function collectSystem(opts: SystemOptions): Promise<SystemSnapshot> {
  const [load, mem, info, temp, time, network, disk, battery, gpu, services] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    cpuInfo(),
    opts.temperature && process.platform !== 'darwin' ? settle(si.cpuTemperature()) : undefined,
    Promise.resolve(si.time()),
    opts.network ? settle(networkInfo()) : undefined,
    opts.disk ? settle(diskInfo()) : undefined,
    opts.battery ? settle(batteryInfo()) : undefined,
    opts.gpu ? settle(gpuInfo()) : undefined,
    settle(servicesInfo(opts.services))
  ]);

  return {
    timestamp: Date.now(),
    cpu: {
      load: load.currentLoad,
      user: load.currentLoadUser,
      system: load.currentLoadSystem,
      cores: load.cpus.map(c => c.load),
      brand: info.brand,
      speed: info.speed,
      ...cpuTemperature(opts.temperature, temp)
    },
    memory: {
      percent: (mem.active / mem.total) * 100,
      used: mem.active,
      total: mem.total,
      swapUsed: mem.swapused,
      swapTotal: mem.swaptotal
    },
    uptime: Number(time.uptime),
    network: opts.network ? network ?? null : undefined,
    disk: opts.disk ? disk ?? [] : undefined,
    battery: opts.battery ? battery ?? null : undefined,
    gpu: opts.gpu ? gpu ?? [] : undefined,
    services: services ?? []
  };
}

function cpuTemperature(enabled: boolean, temp: si.Systeminformation.CpuTemperatureData | undefined) {
  if (!enabled) {
    return { temperature: null, temperatureAvg: null };
  }
  if (process.platform === 'darwin') {
    const t = macTemperature();
    return { temperature: t?.max ?? null, temperatureAvg: t?.avg ?? null };
  }
  return { temperature: temp?.main || temp?.max || null, temperatureAvg: temp?.main || null };
}

export async function cpuLoadAndMemory() {
  const [load, mem] = await Promise.all([si.currentLoad(), si.mem()]);
  return { cpu: load.currentLoad, memory: (mem.active / mem.total) * 100 };
}

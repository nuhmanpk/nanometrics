export async function getGpuInfo() {
  return si.graphics();
}

export async function getBatteryInfo() {
  return si.battery();
}

export async function getNetworkInfo() {
  return si.networkInterfaces();
}
export async function getMongoDBServices() {
  return si.services('mongodb');
}

export async function getRedisServices() {
  return si.services('redis');
}

export async function getDockerServices() {
  return si.services('docker');
}

export async function getNginxServices() {
  return si.services('nginx');
}

export async function getApacheServices() {
  return si.services('apache2');
}

export async function getElasticsearchServices() {
  return si.services('elasticsearch');
}

export async function getRabbitMQServices() {
  return si.services('rabbitmq');
}

export async function getKafkaServices() {
  return si.services('kafka');
}

export async function getPostgresServices() {
  return si.services('postgres');
}

export async function getOracleDBServices() {
  return si.services('oracle');
}

export async function getSqlServerServices() {
  return si.services('sqlserver');
}

export async function getCpuTemperature() {
  return si.cpuTemperature();
}
import si from 'systeminformation';

export async function calculateCurrentCpuLoad() {
  const load = await si.currentLoad();
  return load.currentLoad;
}

export async function calculateCurrentMemoryLoad() {
  const mem = await si.mem();
  return (mem.active / mem.total) * 100;
}

export async function calculateTotalCoreLoad() {
  const load = await si.currentLoad();
  return load.cpus.map(cpu => cpu.load);
}

export async function getMysqlServices() {
  const services = await si.services('mysql');
  return services;
}

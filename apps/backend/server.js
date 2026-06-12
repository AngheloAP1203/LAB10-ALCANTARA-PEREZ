'use strict';

/*
 * API "Hello World" instrumentada para el laboratorio Grafana + Prometheus + Loki.
 * - Expone métricas Prometheus en /metrics
 * - Emite logs en formato JSON (una línea por log) hacia stdout -> Alloy -> Loki
 * - /load quema CPU a propósito para poder disparar la alarma de CPU > 50%
 * - /alerts recibe el webhook de Grafana Alerting y lo registra como log (cierra el ciclo)
 */

const express = require('express');
const client = require('prom-client');
const { Worker } = require('worker_threads');

const PORT = process.env.PORT || 3001;
const SERVICE = 'backend';

// ----------------------------------------------------------------------------
// Logger estructurado en JSON (Alloy lo recoge desde stdout y lo manda a Loki)
// ----------------------------------------------------------------------------
function log(level, msg, fields = {}) {
  process.stdout.write(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      service: SERVICE,
      msg,
      ...fields,
    }) + '\n'
  );
}

// ----------------------------------------------------------------------------
// Métricas Prometheus
// ----------------------------------------------------------------------------
const register = client.register;
client.collectDefaultMetrics({ prefix: 'backend_' });

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total de peticiones HTTP recibidas',
  labelNames: ['method', 'route', 'status'],
});

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duración de las peticiones HTTP en segundos',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
});

// ----------------------------------------------------------------------------
// App
// ----------------------------------------------------------------------------
const app = express();
app.use(express.json());

// Middleware: registra cada petición y alimenta las métricas
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const route = req.route ? req.route.path : req.path;
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequestsTotal.inc({ method: req.method, route, status: res.statusCode });
    httpRequestDuration.observe(
      { method: req.method, route, status: res.statusCode },
      seconds
    );
    log('INFO', 'http_request', {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      latency_ms: Math.round(seconds * 1000),
    });
  });
  next();
});

app.get('/', (req, res) => {
  res.json({ message: 'Hello World desde el backend', service: SERVICE });
});

app.get('/api/hello', (req, res) => {
  const name = req.query.name || 'mundo';
  log('INFO', 'saludo_generado', { user: name });
  res.json({ message: `Hola, ${name}!`, from: SERVICE, time: new Date().toISOString() });
});

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

// Endpoint que quema CPU en un worker thread durante N segundos (máx. 120).
// Sirve para superar el 50% de CPU y disparar la alarma durante la clase.
app.get('/load', (req, res) => {
  const seconds = Math.min(parseInt(req.query.seconds, 10) || 30, 120);
  const workerCode = `
    const end = Date.now() + ${seconds} * 1000;
    while (Date.now() < end) { Math.sqrt(Math.random() * Math.random()); }
  `;
  const worker = new Worker(workerCode, { eval: true });
  worker.on('error', () => {});
  log('WARN', 'cpu_load_test_started', { seconds });
  res.json({ status: 'carga de CPU iniciada', seconds });
});

// Receptor del webhook de Grafana Alerting (opcional, cierra el ciclo)
app.post('/alerts', (req, res) => {
  const body = req.body || {};
  const status = body.status || 'unknown';
  const alerts = Array.isArray(body.alerts) ? body.alerts : [];
  log(status === 'firing' ? 'ERROR' : 'INFO', 'grafana_alert_received', {
    alert_status: status,
    alert_count: alerts.length,
    alertname: alerts[0] && alerts[0].labels && alerts[0].labels.alertname,
  });
  res.json({ received: true });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.listen(PORT, () => {
  log('INFO', 'backend_iniciado', { port: PORT });
});

// ----------------------------------------------------------------------------
// Logs: simulan actividad de negocio para llenar Loki de contenido
// ----------------------------------------------------------------------------
const scenarios = [
  () => log('INFO', 'pedido_creado', { order_id: rand(1000, 9999), amount: rand(10, 500) }),
  () => log('INFO', 'pago_procesado', { order_id: rand(1000, 9999), gateway: 'stripe' }),
  () => log('INFO', 'usuario_autenticado', { user_id: rand(1, 200) }),
  () => log('WARN', 'latencia_alta_en_db', { query_ms: rand(800, 2500) }),
  () => log('WARN', 'reintento_de_pago', { order_id: rand(1000, 9999), attempt: rand(2, 4) }),
  () => log('ERROR', 'fallo_conexion_inventario', { service: 'inventory', code: 503 }),
  () => log('ERROR', 'excepcion_no_controlada', { trace_id: hex(8), endpoint: '/api/checkout' }),
];

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function hex(n) {
  return [...Array(n)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
}

setInterval(() => {
  // ~70% INFO, 20% WARN, 10% ERROR aprox., eligiendo escenarios al azar
  scenarios[rand(0, scenarios.length - 1)]();
}, 4000);

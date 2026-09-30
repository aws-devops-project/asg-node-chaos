const express = require('express');
const { Worker } = require('worker_threads');
const os = require('os');
const si = require('systeminformation');

const app = express();
const PORT = Number(process.env.PORT || 80);
const HOST = process.env.HOST || '0.0.0.0';
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
}
app.use(express.json({ limit: '10kb' }));

// Chaos State
const state = {
    errorRate: 0,       // Percentage of requests to fail (0-100)
    latency: 0,         // Artificial latency in ms
    isHealthy: true,    // Controls ALB Target Group health
    cpuStressing: false,
    memoryStressing: false,
    memoryStressMb: 0
};
let activeLoadTest = null;

function getLoadTestSummary() {
    if (!activeLoadTest) return null;
    const run = activeLoadTest;
    return {
        active: run.active,
        target: run.target,
        durationSeconds: run.durationSeconds,
        requestsPerSecond: run.requestsPerSecond,
        sent: run.sent,
        completed: run.completed,
        succeeded: run.succeeded,
        failed: run.failed,
        inFlight: run.inFlight,
        averageLatencyMs: run.completed ? Math.round(run.totalLatencyMs / run.completed) : 0,
        lastStatus: run.lastStatus,
        startedAt: run.startedAt,
        endedAt: run.endedAt
    };
}

function stopLoadTest(run = activeLoadTest) {
    if (!run || !run.active) return false;
    run.active = false;
    run.endedAt = Date.now();
    clearInterval(run.interval);
    clearTimeout(run.stopTimer);
    for (const controller of run.controllers) controller.abort();
    return true;
}

async function sendLoadRequest(run) {
    if (!run.active || run.inFlight >= 10) return;
    const controller = new AbortController();
    run.controllers.add(controller);
    run.sent++;
    run.inFlight++;
    const startedAt = Date.now();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch(run.requestUrl, {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
            headers: { 'User-Agent': 'ALB-Chaos-Lab-LoadTest/1.0' }
        });
        run.lastStatus = response.status;
        if (response.status >= 200 && response.status < 400) run.succeeded++;
        else run.failed++;
        if (response.body) await response.body.cancel().catch(() => {});
    } catch (error) {
        run.failed++;
        run.lastStatus = error.name === 'AbortError' ? 'timeout/aborted' : 'network error';
    } finally {
        clearTimeout(timeout);
        run.controllers.delete(controller);
        run.inFlight--;
        run.completed++;
        run.totalLatencyMs += Date.now() - startedAt;
    }
}

// Per-process request telemetry; bounded so the lab dashboard cannot grow memory indefinitely.
const requestLogs = [];
const MAX_REQUEST_LOGS = 2000;
const DASHBOARD_DATA_PATH = '/api/dashboard-data';
const RESOURCE_SAMPLE_INTERVAL_MS = 1000;
const RESOURCE_HISTORY_MS = 5 * 60 * 1000;
const resourceSamples = [];

async function sampleHostResources() {
    try {
        const [load, memory, filesystems] = await Promise.all([
            si.currentLoad(),
            si.mem(),
            si.fsSize()
        ]);
        const rootMount = process.platform === 'win32'
            ? (process.env.SystemDrive || 'C:').toLowerCase()
            : '/';
        const filesystem = filesystems.find((entry) => String(entry.mount).toLowerCase() === rootMount)
            || filesystems.find((entry) => entry.size > 0);
        const sample = {
            time: Date.now(),
            cpuPercent: Number.isFinite(load.currentLoad) ? Math.round(load.currentLoad * 10) / 10 : 0,
            memoryPercent: memory.total ? Math.round(memory.used / memory.total * 1000) / 10 : 0,
            memoryUsedBytes: memory.used,
            memoryTotalBytes: memory.total,
            storagePercent: filesystem && Number.isFinite(filesystem.use) ? Math.round(filesystem.use * 10) / 10 : 0,
            storageUsedBytes: filesystem ? filesystem.used : 0,
            storageTotalBytes: filesystem ? filesystem.size : 0,
            storageMount: filesystem ? filesystem.mount : rootMount
        };
        resourceSamples.push(sample);
        const cutoff = sample.time - RESOURCE_HISTORY_MS;
        while (resourceSamples.length && (resourceSamples[0].time < cutoff || resourceSamples.length > 360)) {
            resourceSamples.shift();
        }
    } catch (error) {
        console.error('Unable to sample host resource metrics:', error.message);
    }
}

sampleHostResources();
const resourceSampler = setInterval(sampleHostResources, RESOURCE_SAMPLE_INTERVAL_MS);
resourceSampler.unref();

app.use((req, res, next) => {
    if (req.path === DASHBOARD_DATA_PATH) return next();

    const startedAt = Date.now();
    res.once('finish', () => {
        requestLogs.push({
            time: Date.now(),
            method: req.method,
            path: req.path,
            status: res.statusCode,
            durationMs: Date.now() - startedAt,
            clientIp: (req.get('x-forwarded-for') || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown'
        });
        if (requestLogs.length > MAX_REQUEST_LOGS) {
            requestLogs.splice(0, requestLogs.length - MAX_REQUEST_LOGS);
        }
    });
    next();
});

function getDashboardData() {
    const now = Date.now();
    const windowStart = now - 60000;
    const recent = requestLogs.filter((entry) => entry.time >= windowStart);
    const errors = recent.filter((entry) => entry.status >= 500).length;
    const averageLatency = recent.length
        ? Math.round(recent.reduce((sum, entry) => sum + entry.durationMs, 0) / recent.length)
        : 0;
    const bucketSizeMs = 5000;
    const currentBucket = Math.floor(now / bucketSizeMs);
    const buckets = Array.from({ length: 12 }, (_, index) => ({
        time: (currentBucket - 11 + index) * bucketSizeMs,
        total: 0,
        errors: 0
    }));

    for (const entry of recent) {
        const index = Math.floor(entry.time / bucketSizeMs) - (currentBucket - 11);
        if (index >= 0 && index < buckets.length) {
            buckets[index].total++;
            if (entry.status >= 500) buckets[index].errors++;
        }
    }

    return {
        windowSeconds: 60,
        totalRequests: recent.length,
        requestsPerSecond: (recent.length / 60).toFixed(2),
        errors,
        averageLatencyMs: averageLatency,
        chaos: {
            cpuStressing: state.cpuStressing,
            memoryStressing: state.memoryStressing,
            memoryStressMb: state.memoryStressMb
        },
        loadTest: getLoadTestSummary(),
        series: buckets,
        logs: requestLogs.slice(-50).reverse(),
        resources: resourceSamples.slice()
    };
}

// --- AWS IMDSv2 Metadata Fetcher ---
async function getAwsMetadata() {
    try {
        const tokenRes = await fetch('http://169.254.169.254/latest/api/token', {
            method: 'PUT',
            headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' },
            signal: AbortSignal.timeout(1500)
        });
        if (!tokenRes.ok) throw new Error(`IMDS token request failed: ${tokenRes.status}`);
        const token = await tokenRes.text();
        if (!token) throw new Error('IMDS returned an empty token');
        
        const fetchMeta = async (path) => {
            const res = await fetch(`http://169.254.169.254/latest/meta-data/${path}`, {
                headers: { 'X-aws-ec2-metadata-token': token },
                signal: AbortSignal.timeout(1500)
            });
            if (!res.ok) throw new Error(`IMDS metadata request failed: ${res.status}`);
            return res.text();
        };

        return {
            instanceId: await fetchMeta('instance-id'),
            az: await fetchMeta('placement/availability-zone'),
            localIp: await fetchMeta('local-ipv4')
        };
    } catch (e) {
        return { instanceId: os.hostname(), az: 'local-env', localIp: '127.0.0.1' };
    }
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}

// --- Chaos Middleware ---
app.use((req, res, next) => {
    // Skip chaos for the specific health endpoint and chaos config routes
    if (req.path === '/health' || req.path === DASHBOARD_DATA_PATH || req.path.startsWith('/api/chaos')) return next();

    // 1. Inject Latency
    setTimeout(() => {
        if (res.destroyed) return;
        // 2. Inject Errors
        if (state.errorRate > 0 && (Math.random() * 100) < state.errorRate) {
            return res.status(500).json({ error: 'Chaos injected HTTP 500 Internal Server Error' });
        }
        next();
    }, Math.max(0, state.latency));
});

app.get(DASHBOARD_DATA_PATH, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(getDashboardData());
});

// --- ALB Health Check Endpoint ---
app.get('/health', (req, res) => {
    if (!state.isHealthy) return res.status(503).send("Unhealthy due to chaos injection");
    res.status(200).send("OK");
});

// --- API: Update Chaos Settings ---
app.post('/api/chaos/config', (req, res) => {
    const { errorRate, latency, isHealthy } = req.body || {};
    if (errorRate !== undefined && (!Number.isInteger(errorRate) || errorRate < 0 || errorRate > 100)) {
        return res.status(400).json({ error: 'errorRate must be an integer from 0 to 100.' });
    }
    if (latency !== undefined && (!Number.isInteger(latency) || latency < 0 || latency > 30000)) {
        return res.status(400).json({ error: 'latency must be an integer from 0 to 30000 milliseconds.' });
    }
    if (isHealthy !== undefined && typeof isHealthy !== 'boolean') {
        return res.status(400).json({ error: 'isHealthy must be a boolean.' });
    }
    if (errorRate !== undefined) state.errorRate = errorRate;
    if (latency !== undefined) state.latency = latency;
    if (isHealthy !== undefined) state.isHealthy = isHealthy;
    res.json({ message: "Chaos config updated", state });
});

// --- API: CPU Load Generator ---
app.post('/api/chaos/cpu', async (req, res) => {
    const durationSeconds = !req.body || req.body.durationSeconds === undefined ? 60 : req.body.durationSeconds;
    if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 300) {
        return res.status(400).json({ error: 'durationSeconds must be an integer from 1 to 300 seconds.' });
    }
    if (state.cpuStressing) return res.status(400).json({ error: "CPU stress already running" });
    const duration = durationSeconds * 1000;
    
    state.cpuStressing = true;
    const coreCount = typeof os.availableParallelism === 'function'
        ? os.availableParallelism()
        : os.cpus().length;

    // Worker code to run a tight math loop
    const workerCode = `
        const { parentPort, workerData } = require('worker_threads');
        const end = Date.now() + workerData.duration;
        while (Date.now() < end) { Math.random() * Math.random(); }
        parentPort.postMessage('done');
    `;

    const workers = [];
    try {
        for (let i = 0; i < coreCount; i++) {
            workers.push(new Worker(workerCode, { eval: true, workerData: { duration } }));
        }
    } catch (error) {
        await Promise.all(workers.map((worker) => worker.terminate().catch(() => {})));
        state.cpuStressing = false;
        console.error('Unable to start CPU stress workers:', error);
        return res.status(500).json({ error: 'Unable to start CPU stress workers.' });
    }

    res.json({ message: `Stressing ${coreCount} cores for ${duration / 1000} seconds.` });
    Promise.all(workers.map((worker) => new Promise((resolve) => {
        worker.once('error', (error) => {
            console.error('CPU stress worker failed:', error);
            resolve();
        });
        worker.once('exit', resolve);
    }))).finally(() => {
        state.cpuStressing = false;
    });
});

// --- API: RAM Load Generator ---
app.post('/api/chaos/memory', async (req, res) => {
    const durationSeconds = !req.body || req.body.durationSeconds === undefined ? 60 : req.body.durationSeconds;
    const memoryMb = !req.body || req.body.memoryMb === undefined ? 128 : req.body.memoryMb;
    if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 300) {
        return res.status(400).json({ error: 'durationSeconds must be an integer from 1 to 300 seconds.' });
    }
    if (!Number.isInteger(memoryMb) || memoryMb < 16 || memoryMb > 512) {
        return res.status(400).json({ error: 'memoryMb must be an integer from 16 to 512 MB.' });
    }
    if (state.memoryStressing) return res.status(409).json({ error: 'RAM stress is already running.' });

    const memory = await si.mem();
    const reserveBytes = 256 * 1024 * 1024;
    const safeLimitMb = Math.min(512, Math.floor(Math.max(0, memory.available - reserveBytes) / (1024 * 1024)));
    if (memoryMb > safeLimitMb) {
        return res.status(400).json({ error: `Requested ${memoryMb} MB exceeds this host's safe lab limit of ${safeLimitMb} MB. Leave at least 256 MB free for the OS.` });
    }

    const workerCode = `
        const { parentPort, workerData } = require('worker_threads');
        const blocks = [];
        try {
            let remaining = workerData.memoryMb * 1024 * 1024;
            const blockSize = 8 * 1024 * 1024;
            while (remaining > 0) {
                const size = Math.min(blockSize, remaining);
                const block = new Uint8Array(size);
                for (let offset = 0; offset < size; offset += 4096) block[offset] = 1;
                blocks.push(block);
                remaining -= size;
            }
            parentPort.postMessage({ type: 'ready' });
            setTimeout(() => {
                blocks.length = 0;
                parentPort.postMessage({ type: 'done' });
            }, workerData.durationMs);
        } catch (error) {
            parentPort.postMessage({ type: 'error', message: error.message });
        }
    `;

    let worker;
    try {
        worker = new Worker(workerCode, {
            eval: true,
            workerData: { memoryMb, durationMs: durationSeconds * 1000 }
        });
    } catch (error) {
        console.error('Unable to start RAM stress worker:', error);
        return res.status(500).json({ error: 'Unable to start RAM stress worker.' });
    }

    state.memoryStressing = true;
    state.memoryStressMb = memoryMb;
    let responseSent = false;
    worker.on('message', (message) => {
        if (message.type === 'ready' && !responseSent) {
            responseSent = true;
            res.json({ message: `Using ${memoryMb} MB RAM for ${durationSeconds} seconds.` });
        } else if (message.type === 'error') {
            console.error('RAM stress worker failed:', message.message);
            if (!responseSent) {
                responseSent = true;
                res.status(500).json({ error: 'RAM stress allocation failed; try a smaller amount.' });
            }
            worker.terminate();
        }
    });
    worker.once('error', (error) => {
        console.error('RAM stress worker error:', error);
        if (!responseSent) {
            responseSent = true;
            res.status(500).json({ error: 'RAM stress worker failed.' });
        }
    });
    worker.once('exit', () => {
        state.memoryStressing = false;
        state.memoryStressMb = 0;
        if (!responseSent && !res.headersSent) {
            res.status(500).json({ error: 'RAM stress worker exited before allocation completed.' });
        }
    });
});

// --- API: Bounded load test against an AWS ALB ---
app.post('/api/chaos/load-test', (req, res) => {
    if (activeLoadTest && activeLoadTest.active) {
        return res.status(409).json({ error: 'A load test is already running. Stop it before starting another.' });
    }
    const { targetUrl, durationSeconds, requestsPerSecond } = req.body || {};
    if (typeof targetUrl !== 'string' || targetUrl.length > 2048) {
        return res.status(400).json({ error: 'Enter an ALB URL, such as http://my-alb-123.us-east-1.elb.amazonaws.com/.' });
    }
    let parsedUrl;
    try {
        parsedUrl = new URL(targetUrl);
    } catch {
        return res.status(400).json({ error: 'The target must be a valid absolute URL.' });
    }
    const hostname = parsedUrl.hostname.toLowerCase();
    const isAwsAlbHost = hostname.endsWith('.elb.amazonaws.com') || hostname.endsWith('.elb.amazonaws.com.cn');
    if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || !isAwsAlbHost) {
        return res.status(400).json({ error: 'For safety, target an AWS ALB DNS name ending in .elb.amazonaws.com (or .elb.amazonaws.com.cn) using HTTP or HTTPS.' });
    }
    if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 60) {
        return res.status(400).json({ error: 'durationSeconds must be an integer from 1 to 60.' });
    }
    if (!Number.isInteger(requestsPerSecond) || requestsPerSecond < 1 || requestsPerSecond > 20) {
        return res.status(400).json({ error: 'requestsPerSecond must be an integer from 1 to 20.' });
    }

    const run = {
        active: true,
        target: `${parsedUrl.origin}${parsedUrl.pathname}`,
        requestUrl: parsedUrl.href,
        durationSeconds,
        requestsPerSecond,
        sent: 0,
        completed: 0,
        succeeded: 0,
        failed: 0,
        inFlight: 0,
        totalLatencyMs: 0,
        lastStatus: null,
        startedAt: Date.now(),
        endedAt: null,
        controllers: new Set(),
        interval: null,
        stopTimer: null
    };
    activeLoadTest = run;
    const intervalMs = 1000 / requestsPerSecond;
    sendLoadRequest(run);
    run.interval = setInterval(() => sendLoadRequest(run), intervalMs);
    run.stopTimer = setTimeout(() => stopLoadTest(run), durationSeconds * 1000);
    res.status(202).json({ message: `Load test started: ${requestsPerSecond} requests/second for ${durationSeconds} seconds (maximum ${requestsPerSecond * durationSeconds} requests).`, loadTest: getLoadTestSummary() });
});

app.post('/api/chaos/load-test/stop', (req, res) => {
    const stopped = stopLoadTest();
    if (!activeLoadTest) return res.status(409).json({ error: 'No load test has been started.' });
    res.json({ message: stopped ? 'Load test stopped.' : 'Load test has already finished.', loadTest: getLoadTestSummary() });
});

// --- UI Dashboard ---
app.get('/', async (req, res) => {
    const meta = await getAwsMetadata();
    // Host header usually contains the ALB DNS name
    const dnsName = escapeHtml(req.headers.host || 'Unknown');
    const clientIp = escapeHtml((req.get('x-forwarded-for') || '').split(',')[0].trim() || req.socket.remoteAddress);
    const instanceId = escapeHtml(meta.instanceId);
    const availabilityZone = escapeHtml(meta.az);
    const localIp = escapeHtml(meta.localIp);

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>ASG Node Chaos</title>
            <style>
                * { box-sizing: border-box; }
                body { font-family: system-ui, sans-serif; max-width: 1100px; margin: 32px auto; padding: 0 18px; background: #f3f6fb; color: #263247; }
                h1, h2, p { margin-top: 0; }
                .card { background: white; padding: 22px; border-radius: 14px; box-shadow: 0 8px 28px rgba(24, 39, 75, .07); margin-bottom: 20px; }
                .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
                .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
                .metric { padding: 15px; background: #f1f5fa; border-radius: 10px; font-weight: 650; overflow-wrap: anywhere; }
                .metric small { display:block; color:#718096; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.05em; margin-bottom:8px; }
                .metric strong { font-size:24px; }
                button { padding: 10px 15px; background: #2563eb; color: white; border: 0; border-radius: 7px; cursor: pointer; font-weight: 700; }
                button:hover { filter: brightness(.92); }
                .danger { background: #dc3545; }
                input[type=range] { width: 100%; }
                .chart-wrap { height: 220px; position: relative; }
                .resource-panels { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; }
                .resource-panel { min-width:0; padding:16px; border:1px solid #e8edf4; border-radius:11px; background:#fbfcfe; }
                .resource-panel h3 { margin:0 0 4px; font-size:14px; color:#526177; }
                .resource-value { font-size:26px; font-weight:750; letter-spacing:-.03em; }
                .resource-note { color:#718096; font-size:12px; min-height:18px; }
                .resource-chart { height:150px; margin-top:8px; }
                .load-controls { display:grid; grid-template-columns:minmax(0,2fr) 1fr 1fr auto auto; gap:10px; align-items:end; }
                .load-controls label { display:block; color:#526177; font-size:12px; font-weight:650; }
                .load-controls input { width:100%; padding:10px; margin-top:5px; border:1px solid #cbd5e1; border-radius:7px; }
                .load-status { margin:14px 0 0; padding:12px; background:#f1f5fa; border-radius:8px; color:#526177; }
                canvas { width: 100%; height: 100%; }
                .legend { display:flex; gap:18px; color:#718096; font-size:13px; margin-top:8px; }
                .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:6px; background:#3b82f6; }
                .dot.errors { background:#ef4444; }
                .table-wrap { overflow-x:auto; }
                table { width:100%; border-collapse:collapse; font-size:13px; }
                th, td { text-align:left; padding:10px 8px; border-bottom:1px solid #edf0f5; white-space:nowrap; }
                th { color:#718096; font-size:11px; text-transform:uppercase; letter-spacing:.05em; }
                .status-error { color:#dc3545; font-weight:700; }
                .status-ok { color:#168653; font-weight:700; }
                .muted { color:#718096; }
                @media (max-width:800px) { .resource-panels { grid-template-columns:1fr; } }
                @media (max-width:800px) { .load-controls { grid-template-columns:1fr 1fr; } .load-controls label:first-child { grid-column:1 / -1; } }
                @media (max-width:700px) { .metrics { grid-template-columns:repeat(2,minmax(0,1fr)); } body { margin-top:18px; } }
            </style>
        </head>
        <body>
            <div class="card">
                <h2>📡 Instance & ALB Info</h2>
                <div class="grid">
                    <div class="metric">ALB DNS (Host): <span style="color:#007bff">${dnsName}</span></div>
                    <div class="metric">Instance ID: ${instanceId}</div>
                    <div class="metric">Availability Zone: ${availabilityZone}</div>
                    <div class="metric">Instance private IP: ${localIp}</div>
                    <div class="metric">Client IP: ${clientIp}</div>
                </div>
            </div>

            <div class="card">
                <h2>📈 Live traffic · last 60 seconds</h2>
                <div class="metrics">
                    <div class="metric"><small>Requests</small><strong id="requestCount">0</strong></div>
                    <div class="metric"><small>Requests / sec</small><strong id="requestRate">0.00</strong></div>
                    <div class="metric"><small>HTTP 5xx</small><strong id="errorCount">0</strong></div>
                    <div class="metric"><small>Avg response</small><strong id="averageLatency">0 ms</strong></div>
                </div>
                <div class="chart-wrap"><canvas id="trafficChart" aria-label="Requests and server errors per five-second interval"></canvas></div>
                <div class="legend"><span><i class="dot"></i>Requests</span><span><i class="dot errors"></i>HTTP 5xx</span><span id="updatedAt" class="muted"></span></div>
            </div>

            <div class="card">
                <h2>🖥️ Host utilization · last 5 minutes</h2>
                <p class="muted">Sampled every second on this application instance. Values are host-level, not container-level.</p>
                <div class="resource-panels">
                    <section class="resource-panel">
                        <h3>CPU utilization</h3>
                        <div class="resource-value" id="cpuCurrent">—%</div>
                        <div class="resource-note">All logical processors</div>
                        <div class="resource-chart"><canvas id="cpuChart" aria-label="CPU utilization over five minutes"></canvas></div>
                    </section>
                    <section class="resource-panel">
                        <h3>RAM utilization</h3>
                        <div class="resource-value" id="memoryCurrent">—%</div>
                        <div class="resource-note" id="memoryDetail">Waiting for sample…</div>
                        <div class="resource-chart"><canvas id="memoryChart" aria-label="RAM utilization over five minutes"></canvas></div>
                    </section>
                    <section class="resource-panel">
                        <h3>Storage utilization</h3>
                        <div class="resource-value" id="storageCurrent">—%</div>
                        <div class="resource-note" id="storageDetail">Waiting for sample…</div>
                        <div class="resource-chart"><canvas id="storageChart" aria-label="Root storage utilization over five minutes"></canvas></div>
                    </section>
                </div>
            </div>

            <div class="card">
                <h2>🧾 Recent request logs</h2>
                <p class="muted">Newest 50 requests handled by this app instance. Dashboard polling is excluded.</p>
                <div class="table-wrap">
                    <table><thead><tr><th>Time</th><th>Status</th><th>Method</th><th>Path</th><th>Duration</th><th>Client IP</th></tr></thead>
                        <tbody id="requestLogs"><tr><td colspan="6" class="muted">Waiting for traffic…</td></tr></tbody>
                    </table>
                </div>
            </div>

            <div class="card">
                <h2>⚠️️ Chaos Controls</h2>
                <p>Lab controls: these actions are unauthenticated. Restrict network access to this app.</p>
                
                <div style="margin-bottom: 20px;">
                    <label><strong>Error Rate (HTTP 500s):</strong> <span id="errVal">${state.errorRate}</span>%</label>
                    <input type="range" id="errSlider" min="0" max="100" value="${state.errorRate}" onchange="updateChaos()">
                </div>

                <div class="grid">
                    <div class="metric">
                        <small>CPU spike duration (seconds, 1–300)</small>
                        <input type="number" id="cpuDuration" min="1" max="300" value="60" style="width:100%;padding:8px;margin:6px 0 10px">
                        <button class="danger" onclick="stressCPU()">🔥 Start CPU spike</button>
                        <div id="cpuStatus" class="resource-note" style="margin-top:8px">CPU spike idle</div>
                    </div>
                    <div class="metric">
                        <small>RAM amount (MB, 16–512)</small>
                        <input type="number" id="memoryAmount" min="16" max="512" step="16" value="128" style="width:100%;padding:8px;margin:6px 0 10px">
                        <small>RAM spike duration (seconds, 1–300)</small>
                        <input type="number" id="memoryDuration" min="1" max="300" value="60" style="width:100%;padding:8px;margin:6px 0 10px">
                        <button class="danger" onclick="stressMemory()">🧠 Start RAM spike</button>
                        <div id="memoryStatus" class="resource-note" style="margin-top:8px">RAM spike idle</div>
                    </div>
                    <button onclick="toggleHealth()" id="healthBtn" style="background: ${state.isHealthy ? '#198754' : '#dc3545'}">
                        Target Group Health: ${state.isHealthy ? 'Healthy' : 'Failing'}
                    </button>
                    <button onclick="testRequest()">🔄 Send Test Request to ALB</button>
                </div>
                <div id="testResult" style="margin-top: 15px; padding: 10px; background:#eef2f5; display:none;"></div>
            </div>

            <div class="card">
                <h2>🚦 ALB load test</h2>
                <p class="muted">Send GET requests from this app instance to an AWS ALB DNS name. Lab safety limits: 1–20 requests/second for 1–60 seconds (up to 1,200 requests). Start with a low rate and confirm your AWS budget and scaling policy first.</p>
                <div class="load-controls">
                    <label>ALB URL
                        <input type="url" id="loadTargetUrl" placeholder="https://my-alb-123.us-east-1.elb.amazonaws.com/" spellcheck="false">
                    </label>
                    <label>Requests / second
                        <input type="number" id="loadRps" min="1" max="20" value="2">
                    </label>
                    <label>Duration (seconds)
                        <input type="number" id="loadDuration" min="1" max="60" value="30">
                    </label>
                    <button id="startLoadButton" onclick="startLoadTest()">Start load</button>
                    <button id="stopLoadButton" class="danger" onclick="stopLoadTest()" disabled>Stop</button>
                </div>
                <div id="loadTestStatus" class="load-status" aria-live="polite">No load test run yet.</div>
            </div>

            <script>
                function drawTraffic(series) {
                    const canvas = document.getElementById('trafficChart');
                    const width = canvas.clientWidth;
                    const height = canvas.clientHeight;
                    const scale = window.devicePixelRatio || 1;
                    canvas.width = width * scale;
                    canvas.height = height * scale;
                    const context = canvas.getContext('2d');
                    context.scale(scale, scale);
                    context.clearRect(0, 0, width, height);
                    const max = Math.max(4, ...series.map((point) => point.total));
                    const left = 28, right = 8, top = 12, bottom = 24;
                    const chartHeight = height - top - bottom;
                    const slot = (width - left - right) / series.length;
                    const barWidth = Math.max(5, slot * .55);
                    context.font = '11px system-ui';
                    context.fillStyle = '#94a3b8';
                    context.strokeStyle = '#e8edf4';
                    for (let line = 0; line <= 3; line++) {
                        const y = top + chartHeight * line / 3;
                        context.beginPath(); context.moveTo(left, y); context.lineTo(width - right, y); context.stroke();
                        context.fillText(String(Math.round(max * (3 - line) / 3)), 2, y + 4);
                    }
                    series.forEach((point, index) => {
                        const x = left + index * slot + (slot - barWidth) / 2;
                        const totalHeight = point.total / max * chartHeight;
                        const errorHeight = point.errors / max * chartHeight;
                        context.fillStyle = '#3b82f6';
                        context.fillRect(x, top + chartHeight - totalHeight, barWidth, totalHeight);
                        if (errorHeight > 0) {
                            context.fillStyle = '#ef4444';
                            context.fillRect(x, top + chartHeight - errorHeight, barWidth, errorHeight);
                        }
                    });
                }

                function drawResourceChart(canvasId, samples, property, color) {
                    const canvas = document.getElementById(canvasId);
                    const width = canvas.clientWidth;
                    const height = canvas.clientHeight;
                    if (!width || !height) return;
                    const scale = window.devicePixelRatio || 1;
                    canvas.width = width * scale;
                    canvas.height = height * scale;
                    const context = canvas.getContext('2d');
                    context.scale(scale, scale);
                    context.clearRect(0, 0, width, height);
                    const left = 30, right = 8, top = 10, bottom = 18;
                    const chartWidth = width - left - right;
                    const chartHeight = height - top - bottom;
                    [0, 50, 100].forEach((tick) => {
                        const y = top + chartHeight * (1 - tick / 100);
                        context.beginPath();
                        context.strokeStyle = '#e8edf4';
                        context.moveTo(left, y); context.lineTo(width - right, y); context.stroke();
                        context.fillStyle = '#94a3b8';
                        context.font = '10px system-ui';
                        context.fillText(tick + '%', 1, y + 3);
                    });
                    if (!samples.length) return;
                    context.beginPath();
                    samples.forEach((sample, index) => {
                        const x = left + (samples.length === 1 ? chartWidth : index / (samples.length - 1) * chartWidth);
                        const value = Math.max(0, Math.min(100, Number(sample[property]) || 0));
                        const y = top + chartHeight * (1 - value / 100);
                        if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
                    });
                    context.strokeStyle = color;
                    context.lineWidth = 2;
                    context.stroke();
                    const gradient = context.createLinearGradient(0, top, 0, height - bottom);
                    gradient.addColorStop(0, color + '35');
                    gradient.addColorStop(1, color + '00');
                    context.lineTo(left + chartWidth, height - bottom);
                    context.lineTo(left, height - bottom);
                    context.closePath();
                    context.fillStyle = gradient;
                    context.fill();
                }

                function formatBytes(bytes) {
                    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
                    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
                    let value = bytes, unit = 0;
                    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
                    return value.toFixed(1) + ' ' + units[unit];
                }

                function renderResources(samples) {
                    const latest = samples[samples.length - 1];
                    if (!latest) return;
                    document.getElementById('cpuCurrent').textContent = latest.cpuPercent.toFixed(1) + '%';
                    document.getElementById('memoryCurrent').textContent = latest.memoryPercent.toFixed(1) + '%';
                    document.getElementById('memoryDetail').textContent = formatBytes(latest.memoryUsedBytes) + ' / ' + formatBytes(latest.memoryTotalBytes) + ' used';
                    document.getElementById('storageCurrent').textContent = latest.storagePercent.toFixed(1) + '%';
                    document.getElementById('storageDetail').textContent = latest.storageMount + ' · ' + formatBytes(latest.storageUsedBytes) + ' / ' + formatBytes(latest.storageTotalBytes) + ' used';
                    drawResourceChart('cpuChart', samples, 'cpuPercent', '#5794f2');
                    drawResourceChart('memoryChart', samples, 'memoryPercent', '#b877d9');
                    drawResourceChart('storageChart', samples, 'storagePercent', '#56a64b');
                }

                function renderLogs(logs) {
                    const body = document.getElementById('requestLogs');
                    body.replaceChildren();
                    if (!logs.length) {
                        const row = body.insertRow();
                        const cell = row.insertCell(); cell.colSpan = 6; cell.className = 'muted'; cell.textContent = 'No requests yet — use the app or send a test request.';
                        return;
                    }
                    logs.forEach((entry) => {
                        const row = body.insertRow();
                        const values = [new Date(entry.time).toLocaleTimeString(), entry.status, entry.method, entry.path, entry.durationMs + ' ms', entry.clientIp];
                        values.forEach((value, index) => {
                            const cell = row.insertCell();
                            cell.textContent = value;
                            if (index === 1) cell.className = entry.status >= 500 ? 'status-error' : 'status-ok';
                        });
                    });
                }

                async function refreshDashboard() {
                    try {
                        const response = await fetch('/api/dashboard-data', { cache: 'no-store' });
                        if (!response.ok) throw new Error('Dashboard metrics request failed.');
                        const data = await response.json();
                        document.getElementById('requestCount').textContent = data.totalRequests;
                        document.getElementById('requestRate').textContent = data.requestsPerSecond;
                        document.getElementById('errorCount').textContent = data.errors;
                        document.getElementById('averageLatency').textContent = data.averageLatencyMs + ' ms';
                        document.getElementById('updatedAt').textContent = 'Updated ' + new Date().toLocaleTimeString();
                        document.getElementById('cpuStatus').textContent = data.chaos.cpuStressing ? 'CPU spike running…' : 'CPU spike idle';
                        document.getElementById('memoryStatus').textContent = data.chaos.memoryStressing
                            ? 'RAM spike running · ' + data.chaos.memoryStressMb + ' MB'
                            : 'RAM spike idle';
                        renderLoadTest(data.loadTest);
                        drawTraffic(data.series);
                        renderResources(data.resources);
                        renderLogs(data.logs);
                    } catch (error) {
                        document.getElementById('updatedAt').textContent = error.message;
                    }
                }

                window.addEventListener('resize', refreshDashboard);
                refreshDashboard();
                setInterval(refreshDashboard, 2000);

                async function chaosFetch(url, body) {
                    const response = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.error || 'Chaos request failed.');
                    return result;
                }

                async function updateChaos() {
                    const errorRate = document.getElementById('errSlider').value;
                    document.getElementById('errVal').innerText = errorRate;
                    try {
                        await chaosFetch('/api/chaos/config', { errorRate: parseInt(errorRate, 10) });
                    } catch (error) {
                        alert(error.message);
                    }
                }

                async function stressCPU() {
                    try {
                        const durationSeconds = Number(document.getElementById('cpuDuration').value);
                        const result = await chaosFetch('/api/chaos/cpu', { durationSeconds });
                        alert(result.message);
                    } catch (error) {
                        alert(error.message);
                    }
                }

                async function stressMemory() {
                    try {
                        const memoryMb = Number(document.getElementById('memoryAmount').value);
                        const durationSeconds = Number(document.getElementById('memoryDuration').value);
                        const result = await chaosFetch('/api/chaos/memory', { memoryMb, durationSeconds });
                        alert(result.message);
                    } catch (error) {
                        alert(error.message);
                    }
                }

                function renderLoadTest(run) {
                    const status = document.getElementById('loadTestStatus');
                    const start = document.getElementById('startLoadButton');
                    const stop = document.getElementById('stopLoadButton');
                    if (!run) {
                        status.textContent = 'No load test run yet.';
                        start.disabled = false;
                        stop.disabled = true;
                        return;
                    }
                    const phase = run.active ? 'RUNNING' : 'FINISHED';
                    status.textContent = phase + ' · ' + run.target + ' · sent ' + run.sent
                        + ' · completed ' + run.completed + ' · succeeded ' + run.succeeded
                        + ' · failed ' + run.failed + ' · in flight ' + run.inFlight
                        + ' · average latency ' + run.averageLatencyMs + ' ms'
                        + (run.lastStatus ? ' · last status ' + run.lastStatus : '');
                    start.disabled = run.active;
                    stop.disabled = !run.active;
                }

                async function startLoadTest() {
                    try {
                        const result = await chaosFetch('/api/chaos/load-test', {
                            targetUrl: document.getElementById('loadTargetUrl').value.trim(),
                            requestsPerSecond: Number(document.getElementById('loadRps').value),
                            durationSeconds: Number(document.getElementById('loadDuration').value)
                        });
                        renderLoadTest(result.loadTest);
                    } catch (error) {
                        alert(error.message);
                    }
                }

                async function stopLoadTest() {
                    try {
                        const result = await chaosFetch('/api/chaos/load-test/stop', {});
                        renderLoadTest(result.loadTest);
                    } catch (error) {
                        alert(error.message);
                    }
                }

                async function toggleHealth() {
                    const isHealthy = document.getElementById('healthBtn').innerText.includes('Failing');
                    try {
                        await chaosFetch('/api/chaos/config', { isHealthy });
                        location.reload();
                    } catch (error) {
                        alert(error.message);
                    }
                }

                async function testRequest() {
                    const res = await fetch('/api/work');
                    const div = document.getElementById('testResult');
                    div.style.display = 'block';
                    div.innerHTML = \`Status: <b>\${res.status}</b><br>If error rate > 0, this may randomly return 500.\`;
                }
            </script>
        </body>
        </html>
    `);
});

// A dummy endpoint to test the error rate against
app.get('/api/work', (req, res) => res.json({ message: "Success - handled by " + os.hostname() }));

// Return clean errors for invalid JSON and unexpected request failures.
app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
        return res.status(400).json({ error: 'Request body must contain valid JSON.' });
    }
    console.error('Request failed:', error);
    res.status(500).json({ error: 'Internal server error.' });
});

const server = app.listen(PORT, HOST, () => {
    console.log(`Chaos App listening at http://${HOST}:${PORT}`);
});
server.on('error', (error) => {
    console.error(`Unable to listen on port ${PORT}:`, error.message);
    process.exitCode = 1;
});
import http from 'node:http';
import { URL } from 'node:url';

const PORT = process.env.PORT || 3000;

class NodeServerEngine {
  constructor() {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  async handleRequest(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    res.setHeader('Content-Type', 'application/json');

    if (pathname === '/health' && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok', runtime: 'Node.js 20/22 LTS', timestamp: new Date().toISOString() }));
      return;
    }

    if (pathname === '/api/process' && req.method === 'POST') {
      try {
        const body = await this.readJsonBody(req);
        res.writeHead(200);
        res.end(JSON.stringify({
          status: 'success',
          received: body,
          processedAt: new Date().toISOString()
        }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ status: 'error', message: err.message }));
      }
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ status: 'error', message: 'Endpoint Not Found' }));
  }

  readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (e) {
          reject(new Error('Invalid JSON payload'));
        }
      });
      req.on('error', reject);
    });
  }

  start() {
    this.server.listen(PORT, () => {
      console.log(`[NodeServerEngine] Running on http://localhost:${PORT}`);
    });

    const shutdown = (signal) => {
      console.log(`[NodeServerEngine] Received ${signal}, closing HTTP server...`);
      this.server.close(() => {
        console.log('[NodeServerEngine] Server closed cleanly.');
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }
}

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const engine = new NodeServerEngine();
  engine.start();
}

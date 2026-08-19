# Node.js Engineering Reference & Deep Best Practices

## 1. Event Loop Metrics & Monitoring
- Monitor Event Loop Delay using `node:perf_hooks` (`monitorEventLoopDelay`).
- Avoid sync methods in production routes (`fs.readFileSync`, `JSON.parse` on 50MB files).

## 2. Clustering & Worker Threads
- Use `node:cluster` or PM2 for multi-process scaling on multi-core servers.
- Use `node:worker_threads` for heavy computation or hashing tasks.

## 3. Dependency Security
- Run `npm audit` in CI pipelines.

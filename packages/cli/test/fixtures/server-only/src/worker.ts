// A worker entry: bundled to dist/worker.js next to dist/index.js.
console.log(JSON.stringify({ worker: true, nodeEnv: process.env.NODE_ENV }));

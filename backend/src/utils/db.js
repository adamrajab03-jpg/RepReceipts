const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// CRITICAL: a Pool is an EventEmitter. When an IDLE pooled connection is dropped
// by the server (routine with remote/cloud Postgres after a short idle gap), the
// client emits an 'error' event and the pool re-emits it. With NO listener,
// Node throws "Unhandled 'error' event" → uncaughtException → the process dies
// with no request-level log. This is the crash that surfaces on the next request
// after a pause (e.g. the second accept). The listener turns that fatal event
// into a logged, survivable one — the connection is discarded and the pool
// simply opens a fresh one on the next checkout.
pool.on('error', (err) => {
  console.error('Unexpected error on idle pg client (connection discarded):', err.message);
});

module.exports = pool;

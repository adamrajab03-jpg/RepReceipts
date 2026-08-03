require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const REQUIRED = ['DATABASE_URL', 'JWT_SECRET', 'CSRF_SECRET'];
for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.error(`Error: ${key} environment variable is required`);
    process.exit(1);
  }
}

// Last-resort backstops. With the pool 'error' listener (utils/db) and the
// asyncHandler wrapper on the routes, the known crash sources are handled per
// request; these guarantee that anything else which ever escapes is LOGGED
// loudly instead of killing the server silently. We keep the process alive —
// a single bad request must never take the whole server down.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (kept alive):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (kept alive):', err);
});

const app  = require('./app');
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

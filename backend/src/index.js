require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const REQUIRED = ['DATABASE_URL', 'JWT_SECRET', 'CSRF_SECRET'];
for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.error(`Error: ${key} environment variable is required`);
    process.exit(1);
  }
}

const app  = require('./app');
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

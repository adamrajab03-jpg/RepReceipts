const express = require('express');
const membersRouter = require('./routes/members');
const hearingsRouter = require('./routes/hearings');

const app = express();
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api/members', membersRouter);
app.use('/api/hearings', hearingsRouter);

module.exports = app;

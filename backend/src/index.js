const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const { bootstrap } = require('./bootstrap');
const { verifySocketToken } = require('./auth');
const authRoutes = require('./routes/auth');
const templateRoutes = require('./routes/templates');
const unitRoutes = require('./routes/units');
const farmRoutes = require('./routes/farms');
const maintenanceRoutes = require('./routes/maintenance');
const { buildDeviceRouter } = require('./routes/device');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.use((socket, next) => {
  const user = verifySocketToken(socket.handshake.auth?.token);
  if (!user) return next(new Error('unauthorized'));
  socket.user = user;
  next();
});

io.on('connection', (socket) => {
  socket.on('subscribe', (unitId) => {
    socket.join(`unit:${unitId}`);
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/units', unitRoutes);
app.use('/api/farms', farmRoutes);
app.use('/api/units/:unitId/maintenance', maintenanceRoutes);
app.use('/api/device', buildDeviceRouter(io));

const PORT = process.env.PORT || 4000;

async function start() {
  await bootstrap();
  server.listen(PORT, () => console.log(`[backend] listening on :${PORT}`));
}

start().catch((err) => {
  console.error('[backend] failed to start', err);
  process.exit(1);
});

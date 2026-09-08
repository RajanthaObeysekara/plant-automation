const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const { bootstrap } = require('./bootstrap');
const { verifySocketToken } = require('./auth');
const authRoutes = require('./routes/auth');
const templateRoutes = require('./routes/templates');
const buildRoomsRouter = require('./routes/rooms');
const buildBenchesRouter = require('./routes/benches');
const farmRoutes = require('./routes/farms');
const maintenanceRoutes = require('./routes/maintenance');
const { buildRoomDeviceRouter, buildFarmDeviceRouter } = require('./routes/device');

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
  socket.on('subscribe_room', (roomId) => socket.join(`room:${roomId}`));
  socket.on('subscribe_farm', (farmId) => socket.join(`farm:${farmId}`));
});

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/rooms', buildRoomsRouter(io));
app.use('/api/benches', buildBenchesRouter(io));
app.use('/api/farms', farmRoutes);
app.use('/api/rooms/:roomId/maintenance', maintenanceRoutes);
app.use('/api/device/room', buildRoomDeviceRouter(io));
app.use('/api/device/farm', buildFarmDeviceRouter(io));

const PORT = process.env.PORT || 4000;

async function start() {
  await bootstrap();
  server.listen(PORT, () => console.log(`[backend] listening on :${PORT}`));
}

start().catch((err) => {
  console.error('[backend] failed to start', err);
  process.exit(1);
});

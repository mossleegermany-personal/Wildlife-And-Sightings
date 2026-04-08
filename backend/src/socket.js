/**
 * Socket.IO server singleton.
 *
 * Usage:
 *   const { initSocket, getIO } = require('./socket');
 *   initSocket(httpServer);          // called once in bin/www
 *   getIO().emit('event', payload);  // from anywhere in the backend
 */

const { Server } = require('socket.io');
const logger = require('./utils/logger');

let _io = null;

function initSocket(server) {
  const io = new Server(server, {
    cors: { origin: '*' },
    path: '/socket.io',
  });

  _io = io;

  io.on('connection', (socket) => {
    logger.debug(`[socket] client connected: ${socket.id}`);
    socket.on('disconnect', () => {
      logger.debug(`[socket] client disconnected: ${socket.id}`);
    });
  });

  logger.info('[socket] Socket.IO server initialised');
  return io;
}

function getIO() {
  return _io;
}

module.exports = { initSocket, getIO };

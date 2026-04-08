import { useEffect, useRef, useState, useCallback } from 'react'
import { io } from 'socket.io-client'

let _socket = null

function getSocket() {
  if (!_socket) {
    _socket = io({ path: '/socket.io', autoConnect: true, transports: ['websocket'] })
  }
  return _socket
}

/**
 * useSheetSocket
 *
 * Subscribes to `sheet:update` Socket.IO events for the given sheet range.
 * Calls `onUpdate(rows)` whenever the backend detects new rows.
 *
 * @param {string}   range    - Sheet range string, e.g. 'Telegram!A1:G5000'
 * @param {Function} onUpdate - Callback invoked with the fresh rows array
 * @returns {boolean} connected - Whether the socket is currently connected
 */
export function useSheetSocket(range, onUpdate) {
  const [connected, setConnected] = useState(false)
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate

  useEffect(() => {
    const socket = getSocket()

    const handleConnect = () => setConnected(true)
    const handleDisconnect = () => setConnected(false)
    const handleUpdate = ({ range: updatedRange, rows }) => {
      if (updatedRange === range) onUpdateRef.current(rows)
    }

    socket.on('connect', handleConnect)
    socket.on('disconnect', handleDisconnect)
    socket.on('sheet:update', handleUpdate)

    if (socket.connected) setConnected(true)

    return () => {
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
      socket.off('sheet:update', handleUpdate)
    }
  }, [range])

  return connected
}

export { GameRoom } from './game-room.js';

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }

      const action = url.searchParams.get('action');
      const name = (url.searchParams.get('name') || '').trim().slice(0, 20);

      if (!name) {
        return new Response('Name required', { status: 400 });
      }

      let code;

      if (action === 'create') {
        code = generateCode();
        url.searchParams.set('code', code);
      } else if (action === 'join') {
        code = (url.searchParams.get('code') || '').toUpperCase().trim();
        if (!code || code.length !== 6) {
          return new Response('Invalid code', { status: 400 });
        }
      } else {
        return new Response('Invalid action', { status: 400 });
      }

      const id = env.GAME_ROOM.idFromName(code);
      const stub = env.GAME_ROOM.get(id);
      return stub.fetch(new Request(url.toString(), request));
    }

    return new Response('Not found', { status: 404 });
  },
};

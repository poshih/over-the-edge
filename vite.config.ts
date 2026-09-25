import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { gameTitle } from './build/game-title.ts';

const project = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ mode }) => ({
  envDir: project,
  plugins: [
    gameTitle({ mode, envDir: project }),
    {
      name: 'loopback-art-proxy',
      configureServer(server) {
        server.middlewares.use('/api/art', (request, response, next) => {
          if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) return next();
          response.writeHead(403, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: 'The local artwork service is only available from this computer.' }));
        });
      },
    },
  ],
  server: {
    host: '0.0.0.0', port: 5181, strictPort: true,
    proxy: { '/api/art': { target: 'http://127.0.0.1:8787', changeOrigin: true } },
  },
  preview: { host: '0.0.0.0', port: 4174, strictPort: true },
}));

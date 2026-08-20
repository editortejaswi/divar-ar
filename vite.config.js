import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// GitHub Pages serves a project repo at /<repo>/, so the production build needs
// a matching base. Dev stays at '/'. Change REPO if you use a different name.
const REPO = 'divar-ar';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? `/${REPO}/` : '/',
  plugins: process.env.HTTPS ? [basicSsl()] : [],
  server: {
    host: true,
    allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.loca.lt'],
  },
}));

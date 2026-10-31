import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitro } from 'nitro/vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  server: { port: 3000, host: '127.0.0.1' },
  plugins: [tanstackStart(), nitro(), react()],
})

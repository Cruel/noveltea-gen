import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitro } from 'nitro/vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  server: { port: 3000, host: '127.0.0.1' },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // Authored TypeScript migrations are imported by the native tsx loader.
  // Keep Kysely external in the server build so instanceof SqliteAdapter
  // sees the same class on both sides of the runtime/authoring boundary.
  plugins: [tailwindcss(), tanstackStart(), nitro({ rollupConfig: { external: ['kysely'] } }), react()],
})

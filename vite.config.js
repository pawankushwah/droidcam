import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'; 
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), basicSsl()],
  server: {
    host: true,
    https: true,
  }
})

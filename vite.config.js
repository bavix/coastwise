import { defineConfig } from 'vite'

export default defineConfig({
    root: 'frontend',
    server: {
        proxy: {
            '/api': 'http://127.0.0.1:8080'
        }
    },
    build: {
        outDir: '../web',
        emptyOutDir: true
    }
})

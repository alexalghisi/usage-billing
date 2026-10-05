import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4310}`;

export default defineConfig({
    plugins: [react()],
    server: { port: Number(process.env.WEB_PORT ?? 5310), strictPort: true, proxy: { "/api": api } },
    preview: { port: Number(process.env.WEB_PORT ?? 5310), strictPort: true, proxy: { "/api": api } },
});

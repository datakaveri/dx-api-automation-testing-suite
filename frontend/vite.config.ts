import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  server: {
    port: 3000,
  },
  // es2022 so main.tsx can use top-level await
  build: {
    target: "es2022",
  },
  plugins: [react(), tailwindcss()],
});

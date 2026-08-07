import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://pylon-code.com",
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});

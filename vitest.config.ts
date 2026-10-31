import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        kvNamespaces: ["OAUTH_KV"],
        bindings: {
          GITHUB_CLIENT_ID: "gh-client-id",
          GITHUB_CLIENT_SECRET: "gh-client-secret",
          SIGNING_KEY: "test-signing-key-test-signing-key-0123456789",
          YOUTUBE_API_KEY: "YTKEY-MARKER-123",
          SUPADATA_API_KEY: "SDKEY-MARKER-456",
          ALLOWED_GITHUB_USERS: "Moj-Login,4242",
          YT_DELAY_MS: "0",
          SD_MIN_INTERVAL_MS: "0",
          SD_ITEM_DELAY_MS: "0",
          ALARM_DELAY_MS: "0",
        },
      },
    }),
  ],
  // fileParallelism: false: pliki testów idą jeden po drugim (równoległe uruchamianie kilku instancji workerd losowo zawieszało start puli: „Timeout starting cloudflare-pool runner”)
  test: { include: ["test/**/*.test.ts"], testTimeout: 60000, fileParallelism: false },
});

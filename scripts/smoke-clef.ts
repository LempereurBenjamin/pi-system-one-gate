import { CloudflareClefProvider } from "../src/providers/cloudflare-clef-provider.ts";

const provider = new CloudflareClefProvider({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "", token: process.env.CLOUDFLARE_AUTH_TOKEN ?? "",
  model: "clef-flash", timeoutMs: 8000,
});
try {
  const result = await provider.decide("Synthetic test run: the compiler failed. Download progress is unrelated.", {
    error: { type: "noul", instructions: "Does the state describe a compiler failure?" },
    success: { type: "noul", instructions: "Did compilation succeed?" },
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "smoke failed");
  process.exitCode = 1;
}

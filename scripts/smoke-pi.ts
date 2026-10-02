import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

// Public SDK loader, actual package directory discovery, isolated user/project settings.
const dir = await mkdtemp(join(tmpdir(), "system-one-gate-pi-"));
try {
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: join(dir, "agent"), settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [resolve(".")], noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings ?? [], []);
  const extension = result.extensions.find(e => e.path.endsWith("src/extension.ts"));
  assert.ok(extension, "Pi must discover the extension through package.json pi.extensions");
  assert.ok(extension.handlers.has("before_agent_start"));
  assert.ok(extension.handlers.has("tool_result"));
  console.log("PASS: Pi package discovery and real extension loading; no model calls or global settings changes.");
} finally {
  await rm(dir, { recursive: true, force: true });
}

import { chmod, lstat, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

export function cacheRoot(): string {
  return join(homedir(), ".cache", "pi-system-one-gate");
}

export class LocalArchive {
  private directory: Promise<string> | undefined;
  private bytes = 0;
  private files = 0;
  constructor(private readonly root = cacheRoot(), private readonly project?: string) {}

  private async initialize(): Promise<string> {
    const root = resolve(this.root);
    const project = this.project && resolve(this.project);
    if (project && (root === project || root.startsWith(project + sep))) throw new Error("archive-in-project");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error("unsafe-archive-root");
    const actualRoot = await realpath(root);
    const actualProject = project && await realpath(project);
    if (actualProject && (actualRoot === actualProject || actualRoot.startsWith(actualProject + sep))) throw new Error("archive-in-project");
    await chmod(root, 0o700);
    const dir = await mkdtemp(join(root, "run-"));
    await chmod(dir, 0o700);
    return dir;
  }

  async save(text: string): Promise<string> {
    const bytes = Buffer.byteLength(text);
    if (this.files >= 100 || this.bytes + bytes > 50_000_000) throw new Error("archive-limit");
    // Reserve before awaiting: parallel tool results share one per-run budget.
    this.files++; this.bytes += bytes;
    this.directory ??= this.initialize();
    const file = join(await this.directory, `${randomUUID()}.txt`);
    await writeFile(file, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return file;
  }
}

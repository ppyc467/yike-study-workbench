import { spawnSync } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const build = spawnSync(process.execPath, [path.join(root, "scripts/run-framework.mjs"), "build", ...process.argv.slice(2)], { cwd: root, stdio: "inherit", windowsHide: true });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const client = path.join(root, "dist/client");
async function assets(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await assets(file));
    else if (/\.(?:m?js|css|woff2?|ttf|otf)$/.test(entry.name)) files.push("/" + path.relative(client, file).split(path.sep).join("/"));
  }
  return files;
}
await writeFile(path.join(client, "offline-assets.json"), JSON.stringify({ assets: (await assets(client)).sort() }));

import { copyFile, mkdir } from "node:fs/promises";

const destination = new URL("../dist/swagger/", import.meta.url);
await mkdir(destination, { recursive: true });
for (const filename of [
  "swagger-ui.css",
  "swagger-ui-bundle.js",
  "LICENSE",
  "NOTICE",
]) {
  await copyFile(
    new URL(`../node_modules/swagger-ui-dist/${filename}`, import.meta.url),
    new URL(filename, destination),
  );
}

import { readFile, writeFile } from "node:fs/promises";
import SwaggerParser from "@apidevtools/swagger-parser";
import { openApiDocument } from "../src/openapi/document.ts";

if (process.argv.slice(2).some((argument) => argument !== "--check"))
  throw new Error("Only --check is supported");
// Validate a clone: SwaggerParser dereferences/mutates the input document.
await SwaggerParser.validate(structuredClone(openApiDocument));
const destination = new URL("../docs/openapi.json", import.meta.url);
const serialized = `${JSON.stringify(openApiDocument, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if ((await readFile(destination, "utf8")) !== serialized)
    throw new Error("OpenAPI export is stale. Run: bun run docs:generate");
} else {
  await writeFile(destination, serialized);
}
console.log(
  `OpenAPI valid: ${Object.values(openApiDocument.paths).reduce((count, path) => count + Object.keys(path).length, 0)} operations; export ${process.argv.includes("--check") ? "current" : "written"}.`,
);

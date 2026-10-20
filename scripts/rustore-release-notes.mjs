import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const metadataUrl = new URL("../distribution/rustore/metadata.ru.md", import.meta.url);

export function resolveRuStoreReleaseNotes({
  override = process.env.RUSTORE_RELEASE_NOTES,
  readMetadata = () => readFileSync(metadataUrl, "utf8"),
} = {}) {
  let notes = String(override ?? "").trim();
  if (!notes) {
    const lines = readMetadata().split(/\r?\n/);
    const start = lines.findIndex((line) => /^##[ \t]+Что нового[ \t]*$/.test(line));
    if (start < 0) {
      throw new Error("RuStore metadata must contain a '## Что нового' section.");
    }
    const section = lines.slice(start + 1);
    const end = section.findIndex((line) => /^#{1,2}[ \t]+/.test(line));
    notes = (end < 0 ? section : section.slice(0, end)).join("\n").trim();
  }
  if (!notes) {
    throw new Error("RuStore release notes are empty. Fill 'Что нового' in the store metadata or provide release_notes.");
  }
  if (notes.length > 5000) {
    throw new Error("RuStore release notes must not exceed 5000 characters.");
  }
  return notes;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const notes = resolveRuStoreReleaseNotes();
    process.stdout.write(`RuStore release notes verified (${notes.length} characters).\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

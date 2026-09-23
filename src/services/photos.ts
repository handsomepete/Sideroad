import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1", "heif"]);

/** Identify an image by its first bytes. We never trust the filename or the browser's content type. */
export function detectImageType(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { mime: "image/png", ext: "png" };
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP")
    return { mime: "image/webp", ext: "webp" };
  if (buf.toString("ascii", 0, 4) === "GIF8") return { mime: "image/gif", ext: "gif" };
  if (buf.toString("ascii", 4, 8) === "ftyp" && HEIF_BRANDS.has(buf.toString("ascii", 8, 12)))
    return { mime: "image/heic", ext: "heic" };
  return null;
}

export class PhotoError extends Error {}

/** Validate and write a photo to the upload directory. Returns what to store in the photos table. */
export async function savePhoto(
  uploadDir: string,
  buf: Buffer,
): Promise<{ storedName: string; mimeType: string; sizeBytes: number }> {
  if (buf.length > MAX_PHOTO_BYTES) throw new PhotoError("Photo is too large (10 MB maximum).");
  const type = detectImageType(buf);
  if (!type) throw new PhotoError("That file doesn't look like a photo. Please use a JPG, PNG, HEIC or WebP image.");
  await mkdir(uploadDir, { recursive: true, mode: 0o750 });
  const storedName = `${randomUUID()}.${type.ext}`;
  await writeFile(join(uploadDir, storedName), buf, { mode: 0o640 });
  return { storedName, mimeType: type.mime, sizeBytes: buf.length };
}

// Shared photo compression utility — used by usePhotoExtract and usePhotoExtractCustomers.
// Extracted 2026-05-29 to eliminate byte-identical duplication.

const MAX_PX = 1024;
const WEBP_QUALITY = 0.8;
const SKIP_THRESHOLD = 500 * 1024; // 500 KB

export async function compressToWebP(file: File): Promise<File | Blob> {
  if (file.size < SKIP_THRESHOLD) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_PX / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob(res, "image/webp", WEBP_QUALITY)
    );
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, ".webp"), { type: "image/webp" });
  } catch {
    return file; // fall back to original on any error
  }
}

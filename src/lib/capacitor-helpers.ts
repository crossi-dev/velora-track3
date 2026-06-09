"use client";

import { Capacitor } from "@capacitor/core";

/**
 * Capacitor runtime helpers.
 *
 * These functions detect whether the app is running inside a Capacitor
 * WebView and provide native-aware alternatives for behaviors that do
 * not work in Android WebView (external links, blob downloads).
 */

// Never check `window.Capacitor` directly — `@capacitor/core` polyfills that
// global on every web page load as an import side-effect, so it is truthy on
// desktop too. `Capacitor.getPlatform()` returns "web" on browsers and
// "android" / "ios" only inside the real native shell.
export function isCapacitor(): boolean {
  const platform = Capacitor.getPlatform();
  return platform === "android" || platform === "ios";
}

/**
 * Open a URL externally (system browser / target app).
 *
 * In a normal browser: creates a hidden <a> and clicks it.
 * In Capacitor: uses the Browser plugin to open in the system browser,
 * which allows Android to resolve wa.me links to the WhatsApp app.
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  if (typeof document === "undefined") return false;

  try {
    if (isCapacitor()) {
      const { Browser } = await import("@capacitor/browser");
      await Browser.open({ url, windowName: "_system" });
      return true;
    }

    // Fallback: standard browser — hidden anchor click
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    return true;
  } catch (err) {
    console.error("[capacitor-helpers] openExternalUrl falló.", url, err);
    return false;
  }
}

/**
 * Download a PDF blob to the device.
 *
 * In a normal browser: uses blob URL + <a download>.
 * In Capacitor: writes the blob to the filesystem and opens the share
 * sheet so the user can save/share the PDF.
 */
export async function downloadPdfBlob(
  blob: Blob,
  filename: string
): Promise<boolean> {
  try {
    if (isCapacitor()) {
      const { Filesystem, Directory } = await import("@capacitor/filesystem");
      const { Share } = await import("@capacitor/share");

      // Convert blob to base64
      const buffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);

      // Write to cache directory
      const result = await Filesystem.writeFile({
        path: filename,
        data: base64,
        directory: Directory.Cache,
      });

      // Open share sheet
      try {
        await Share.share({
          title: filename,
          url: result.uri,
        });
      } catch (shareErr) {
        // User cancelled the share sheet — file was written successfully.
        // Cancellation is not an error; the user explicitly dismissed the sheet.
        const msg =
          shareErr instanceof Error ? shareErr.message.toLowerCase() : "";
        if (
          msg.includes("cancel") ||
          msg.includes("dismiss") ||
          msg.includes("share canceled")
        ) {
          return true;
        }
        console.error("Share failed:", shareErr);
        return false;
      }

      return true;
    }

    // Fallback: standard browser — blob URL + anchor download
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
    return true;
  } catch (err) {
    console.error("[capacitor-helpers] downloadPdfBlob falló.", filename, err);
    return false;
  }
}

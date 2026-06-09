"use client";

import { useState, useCallback } from "react";
import { tLang } from "../DashboardLangContext";
import type { UploadPreviewResponse, ImportRow, ImportType } from "@/app/api/upload-file/route";

export interface UploadPreview {
  importType: ImportType;
  count: number;
  rows: ImportRow[];
  previewItems: string[];
}

interface UseFileUploadReturn {
  uploadPreview: UploadPreview | null;
  uploadLoading: boolean;
  uploadError: string | null;
  handleFileSelect: (file: File) => Promise<void>;
  handleImportConfirm: () => Promise<void>;
  handleImportDismiss: () => void;
}

export function useFileUpload(): UseFileUploadReturn {
  const [uploadPreview, setUploadPreview] = useState<UploadPreview | null>(null);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const handleFileSelect = useCallback(async (file: File) => {
    setUploadLoading(true);
    setUploadError(null);
    setUploadPreview(null);

    // PDF / Word → supervisor extracts business rules
    if (/\.(pdf|docx)$/i.test(file.name)) {
      try {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/business/business-rules/import-document", { method: "POST", body: formData });
        const data = await res.json() as { imported?: number; answer?: string; error?: string };
        if (!res.ok || data.error) {
          setUploadError(data.error ?? tLang("Could not process the file.", "No se pudo procesar el archivo."));
          return;
        }
        const rulesCount = data.imported;
        const msg = data.answer
          ?? (rulesCount
            ? tLang(`${rulesCount} rule${rulesCount === 1 ? "" : "s"} imported.`, `${rulesCount} regla${rulesCount === 1 ? "" : "s"} importada${rulesCount === 1 ? "" : "s"}.`)
            : tLang("No rules found in the document.", "No se encontraron reglas en el documento."));
        setUploadError(`__success__${msg}`);
      } catch {
        setUploadError(tLang("Connection error uploading the file.", "Error de conexión al subir el archivo."));
      } finally {
        setUploadLoading(false);
      }
      return;
    }

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/upload-file", { method: "POST", body: formData });
      const data = await res.json() as UploadPreviewResponse & { error?: string };

      if (!res.ok || data.error) {
        setUploadError(data.error ?? tLang("Could not process the file.", "No se pudo procesar el archivo."));
        return;
      }

      setUploadPreview({
        importType: data.importType,
        count: data.count,
        rows: data.rows,
        previewItems: data.previewItems,
      });
    } catch {
      setUploadError(tLang("Connection error uploading the file.", "Error de conexión al subir el archivo."));
    } finally {
      setUploadLoading(false);
    }
  }, []);

  const handleImportConfirm = useCallback(async () => {
    if (!uploadPreview) return;
    setUploadLoading(true);
    setUploadError(null);

    try {
      const res = await fetch("/api/upload-file/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ importType: uploadPreview.importType, rows: uploadPreview.rows }),
      });
      const data = await res.json() as { imported: number; skipped: number; errors: string[]; error?: string };

      if (!res.ok || data.error) {
        setUploadError(data.error ?? tLang("Import failed.", "Error al importar."));
        return;
      }

      const label = uploadPreview.importType === "products" ? tLang("products", "productos") : tLang("customers", "clientes");
      const msg = data.skipped > 0
        ? tLang(`✓ ${data.imported} ${label} imported, ${data.skipped} duplicates skipped.`, `✓ ${data.imported} ${label} importados, ${data.skipped} duplicados omitidos.`)
        : tLang(`✓ ${data.imported} ${label} imported.`, `✓ ${data.imported} ${label} importados.`);
      setUploadPreview(null);
      // Dismiss with success message surfaced via error channel (re-used as notice)
      setUploadError(`__success__${msg}`);
    } catch {
      setUploadError(tLang("Connection error importing.", "Error de conexión al importar."));
    } finally {
      setUploadLoading(false);
    }
  }, [uploadPreview]);

  const handleImportDismiss = useCallback(() => {
    setUploadPreview(null);
    setUploadError(null);
  }, []);

  return {
    uploadPreview,
    uploadLoading,
    uploadError,
    handleFileSelect,
    handleImportConfirm,
    handleImportDismiss,
  };
}

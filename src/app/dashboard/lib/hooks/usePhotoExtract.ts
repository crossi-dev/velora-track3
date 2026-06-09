"use client";

// Hook que envía la foto del cuaderno o etiquetas a /api/onboarding/photo-extract,
// expone los productos extraídos para que el draft inline los muestre y luego
// los crea uno por uno via executeDashboardAction("product.create"). Sin
// endpoint bulk en v1 — una action por producto basta para los 5-10 items
// típicos de la primera carga, y enforce-action-node exige pasar por el node.

import { useCallback, useState } from "react";
import { tLang } from "../DashboardLangContext";
import { executeDashboardAction } from "../actions/executeDashboardAction";
import { compressToWebP } from "./utils.photo";

export interface PhotoProduct {
  name: string;
  price: number | null;
  stock: number | null;
}

interface UsePhotoExtractReturn {
  photoProducts: PhotoProduct[] | null;
  setPhotoProducts: (next: PhotoProduct[] | null) => void;
  photoLoading: boolean;
  photoError: string | null;
  photoSuccess: string | null;
  handlePhotoSelect: (file: File) => Promise<void>;
  handlePhotoConfirm: () => Promise<void>;
  handlePhotoDismiss: () => void;
}

export function usePhotoExtract(opts: {
  businessId: string | null;
  onCreated?: () => void;
}): UsePhotoExtractReturn {
  const [photoProducts, setPhotoProducts] = useState<PhotoProduct[] | null>(null);
  const [photoLoading, setPhotoLoading] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoSuccess, setPhotoSuccess] = useState<string | null>(null);

  const handlePhotoSelect = useCallback(async (file: File) => {
    setPhotoLoading(true);
    setPhotoError(null);
    setPhotoSuccess(null);
    setPhotoProducts(null);
    try {
      const uploadFile = await compressToWebP(file);
      const formData = new FormData();
      formData.append("file", uploadFile);
      const res = await fetch("/api/onboarding/photo-extract", { method: "POST", body: formData });
      const data = await res.json() as { products?: PhotoProduct[]; error?: string; message?: string };
      if (!res.ok) {
        setPhotoError(data.message ?? data.error ?? tLang("Could not read the photo.", "No pude leer la foto."));
        return;
      }
      const products = Array.isArray(data.products) ? data.products : [];
      if (products.length === 0) {
        setPhotoError(tLang("No products detected in the photo.", "No detecté productos en la foto. Probá con una más nítida."));
        return;
      }
      setPhotoProducts(products);
    } catch {
      setPhotoError(tLang("Connection error uploading the photo.", "Error de conexión al subir la foto."));
    } finally {
      setPhotoLoading(false);
    }
  }, []);

  const handlePhotoConfirm = useCallback(async () => {
    if (!photoProducts || photoProducts.length === 0) return;
    if (!opts.businessId) {
      setPhotoError(tLang("Business not loaded yet.", "Negocio aún no cargado."));
      return;
    }
    setPhotoLoading(true);
    setPhotoError(null);
    let imported = 0;
    const errors: string[] = [];
    for (const p of photoProducts) {
      if (!p.name.trim()) continue;
      try {
        const result = await executeDashboardAction("product.create", {
          businessId: opts.businessId,
          name: p.name.trim(),
          price: typeof p.price === "number" && p.price > 0 ? p.price : 0,
          stock: typeof p.stock === "number" && p.stock >= 0 ? p.stock : 0,
        });
        if (result?.product?.id) imported++;
        else errors.push(p.name);
      } catch {
        errors.push(p.name);
      }
    }
    setPhotoLoading(false);
    if (imported > 0) {
      setPhotoProducts(null);
      const errorTail = errors.length > 0
        ? tLang(` (${errors.length} failed)`, ` (${errors.length} no se pudieron cargar)`)
        : "";
      setPhotoSuccess(tLang(`✓ ${imported} products created.${errorTail}`, `✓ ${imported} producto${imported === 1 ? "" : "s"} cargado${imported === 1 ? "" : "s"}.${errorTail}`));
      opts.onCreated?.();
    } else {
      setPhotoError(tLang("Could not create the products. Try again.", "No se pudieron crear los productos. Probá de nuevo."));
    }
  }, [photoProducts, opts]);

  const handlePhotoDismiss = useCallback(() => {
    setPhotoProducts(null);
    setPhotoError(null);
    setPhotoSuccess(null);
  }, []);

  return {
    photoProducts,
    setPhotoProducts,
    photoLoading,
    photoError,
    photoSuccess,
    handlePhotoSelect,
    handlePhotoConfirm,
    handlePhotoDismiss,
  };
}

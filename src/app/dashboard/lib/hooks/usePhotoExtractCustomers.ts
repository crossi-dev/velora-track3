"use client";

// Hook que envía la foto de la lista de clientes a
// /api/onboarding/photo-extract-customers, expone los clientes extraídos
// para que el draft inline los muestre y luego los crea via executeDashboardAction.

import { useCallback, useState } from "react";
import { tLang } from "../DashboardLangContext";
import { executeDashboardAction } from "../actions/executeDashboardAction";
import { compressToWebP } from "./utils.photo";

export interface PhotoCustomer {
  name: string;
  phone: string | null;
}

interface UsePhotoExtractCustomersReturn {
  photoCustomers: PhotoCustomer[] | null;
  setPhotoCustomers: (next: PhotoCustomer[] | null) => void;
  photoCustomersLoading: boolean;
  photoCustomersError: string | null;
  photoCustomersSuccess: string | null;
  handleCustomerPhotoSelect: (file: File) => Promise<void>;
  handleCustomerPhotoConfirm: () => Promise<void>;
  handleCustomerPhotoDismiss: () => void;
}

export function usePhotoExtractCustomers(opts: {
  businessId: string | null;
  onCreated?: () => void;
}): UsePhotoExtractCustomersReturn {
  const [photoCustomers, setPhotoCustomers] = useState<PhotoCustomer[] | null>(null);
  const [photoCustomersLoading, setPhotoCustomersLoading] = useState(false);
  const [photoCustomersError, setPhotoCustomersError] = useState<string | null>(null);
  const [photoCustomersSuccess, setPhotoCustomersSuccess] = useState<string | null>(null);

  const handleCustomerPhotoSelect = useCallback(async (file: File) => {
    setPhotoCustomersLoading(true);
    setPhotoCustomersError(null);
    setPhotoCustomersSuccess(null);
    setPhotoCustomers(null);
    try {
      const uploadFile = await compressToWebP(file);
      const formData = new FormData();
      formData.append("file", uploadFile);
      const res = await fetch("/api/onboarding/photo-extract-customers", { method: "POST", body: formData });
      const data = await res.json() as { customers?: PhotoCustomer[]; error?: string; message?: string };
      if (!res.ok) {
        setPhotoCustomersError(data.message ?? data.error ?? tLang("Could not read the photo.", "No pude leer la foto."));
        return;
      }
      const customers = Array.isArray(data.customers) ? data.customers : [];
      if (customers.length === 0) {
        setPhotoCustomersError(tLang("No customers detected in the photo.", "No detecté clientes en la foto. Probá con una más nítida."));
        return;
      }
      setPhotoCustomers(customers);
    } catch {
      setPhotoCustomersError(tLang("Connection error uploading the photo.", "Error de conexión al subir la foto."));
    } finally {
      setPhotoCustomersLoading(false);
    }
  }, []);

  const handleCustomerPhotoConfirm = useCallback(async () => {
    if (!photoCustomers || photoCustomers.length === 0) return;
    if (!opts.businessId) {
      setPhotoCustomersError(tLang("Business not loaded yet.", "Negocio aún no cargado."));
      return;
    }
    setPhotoCustomersLoading(true);
    setPhotoCustomersError(null);
    let imported = 0;
    const errors: string[] = [];
    for (const c of photoCustomers) {
      if (!c.name.trim()) continue;
      try {
        const result = await executeDashboardAction("customer.create", {
          businessId: opts.businessId,
          name: c.name.trim(),
          phone: c.phone ?? undefined,
          email: undefined,
          taxId: undefined,
        });
        if (result?.customer?.id) imported++;
        else errors.push(c.name);
      } catch {
        errors.push(c.name);
      }
    }
    setPhotoCustomersLoading(false);
    if (imported > 0) {
      setPhotoCustomers(null);
      const errorTail = errors.length > 0
        ? tLang(` (${errors.length} failed)`, ` (${errors.length} no se pudieron cargar)`)
        : "";
      setPhotoCustomersSuccess(tLang(
        `✓ ${imported} customers created.${errorTail}`,
        `✓ ${imported} cliente${imported === 1 ? "" : "s"} cargado${imported === 1 ? "" : "s"}.${errorTail}`
      ));
      opts.onCreated?.();
    } else {
      setPhotoCustomersError(tLang("Could not create the customers. Try again.", "No se pudieron crear los clientes. Probá de nuevo."));
    }
  }, [photoCustomers, opts]);

  const handleCustomerPhotoDismiss = useCallback(() => {
    setPhotoCustomers(null);
    setPhotoCustomersError(null);
    setPhotoCustomersSuccess(null);
  }, []);

  return {
    photoCustomers,
    setPhotoCustomers,
    photoCustomersLoading,
    photoCustomersError,
    photoCustomersSuccess,
    handleCustomerPhotoSelect,
    handleCustomerPhotoConfirm,
    handleCustomerPhotoDismiss,
  };
}

import { normalizeInput, normalizeNullableInput } from "../../../../lib/normalize";

export { normalizeInput, normalizeNullableInput };

export interface SupplierBody {
  id?: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  taxId?: string | null;
  contactName?: string | null;
  leadTimeDays?: number | null;
}

export type PurchaseRequestPayload = {
  supplier?: {
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    contactName?: string | null;
  };
  [key: string]: unknown;
};

export const MAX_SUPPLIER_FIELD_LENGTH = 500;

export function toSupplierResponse(supplier: {
  id: string;
  name: string;
  phone: string | null;
  contactName: string | null;
  email: string | null;
  leadTimeDays?: number | null;
}) {
  return {
    id: supplier.id,
    name: supplier.name,
    phone: supplier.phone,
    contactName: supplier.contactName,
    taxId: null,
    email: supplier.email,
    leadTimeDays: supplier.leadTimeDays ?? 3,
  };
}

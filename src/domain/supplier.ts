// Core domain types — no UI, no framework dependencies

export interface Supplier {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  contactName?: string | null;
  leadTimeDays?: number | null;
}

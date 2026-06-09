// Core domain types — no UI, no framework dependencies

export type EmployeeRole = "employee";

export interface Employee {
  id: string;
  businessId: string;
  name: string;
  pinHash: string;
  role: EmployeeRole;
  active: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

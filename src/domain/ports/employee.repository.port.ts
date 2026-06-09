export interface EmployeeCreateArgs {
  businessId: string;
  name: string;
  pinHash: string;
  role: string;
}

export interface EmployeeRecord {
  id: string;
  name: string;
  role: string;
  active: boolean;
  createdAt: Date;
}

export interface EmployeeListRecord {
  id: string;
  name: string;
  role: string;
  active: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  lockedUntil: Date | null;
  failedPinAttempts: number;
}

export interface EmployeeRepositoryPort {
  findByName(businessId: string, name: string): Promise<{ id: string } | null>;
  create(args: EmployeeCreateArgs): Promise<EmployeeRecord>;
  findById(businessId: string, employeeId: string): Promise<{ id: string; name: string; role: string; active: boolean } | null>;
  revoke(businessId: string, employeeId: string): Promise<void>;
  list(businessId: string): Promise<EmployeeListRecord[]>;
}

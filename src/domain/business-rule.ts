// Core domain types — no UI, no framework dependencies

export type BusinessRuleKind =
  | "time-based"
  | "condition-based"
  | "behavior-based";

export interface BusinessRule {
  id: string;
  businessId: string;
  kind: BusinessRuleKind;
  trigger: string;
  message: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessRuleCreateArgs {
  businessId: string;
  kind: string;
  trigger: string;
  message: string;
}

export interface BusinessRuleRecord {
  id: string;
  kind: string;
  trigger: string;
  message: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface BusinessRuleClassification {
  kind: "time-based" | "condition-based" | "behavior-based";
  cron: string | null;
  trigger?: string;
}

export interface BusinessRuleRepositoryPort {
  /** Returns the rule's id and kind so callers can validate (e.g. cron check) before writing. */
  findByTrigger(businessId: string, trigger: string): Promise<{ id: string; kind: string } | null>;
  create(args: BusinessRuleCreateArgs): Promise<BusinessRuleRecord>;
  list(businessId: string): Promise<BusinessRuleRecord[]>;
  update(businessId: string, ruleId: string, updates: { kind?: string; trigger?: string; message?: string; active?: boolean }): Promise<BusinessRuleRecord | null>;
  delete(businessId: string, ruleId: string): Promise<{ deleted: boolean }>;
  /**
   * Deactivates ALL active rows matching (businessId, trigger) in a single updateMany.
   * Restores the old updateMany({active:true}) → {active:false} semantics.
   * Returns the count of rows actually deactivated (0 → caller treats as not_found).
   */
  deactivateAllActiveByTrigger(businessId: string, trigger: string): Promise<{ count: number }>;
}

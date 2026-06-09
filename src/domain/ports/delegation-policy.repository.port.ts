export interface DelegationPolicyCreateArgs {
  businessId: string;
  scope: string;
  maxValue: number | null;
  requiresOwner: boolean;
  conditions: string;
}

export interface DelegationPolicyRecord {
  id: string;
  scope: string;
  /** Numeric limit (policy-specific semantics). null = no limit. */
  maxValue: number | null;
  requiresOwner: boolean;
  conditions: string;
  active: boolean;
}

export interface DelegationPolicyRepositoryPort {
  /**
   * Returns { id } for the first active policy matching businessId + scope,
   * or null when none exists. Used by create to detect existing-scope upsert.
   */
  findActiveByScope(businessId: string, scope: string): Promise<{ id: string } | null>;

  /**
   * Persist a new DelegationPolicy row. No upsert at the DB layer — callers
   * that want upsert semantics call findActiveByScope first, then create or update.
   */
  create(args: DelegationPolicyCreateArgs): Promise<DelegationPolicyRecord>;

  /**
   * Partial update of an existing policy. Scoped by businessId + policyId for
   * defense-in-depth tenant isolation. Returns null when not found.
   */
  update(
    businessId: string,
    policyId: string,
    updates: {
      maxValue?: number | null;
      requiresOwner?: boolean;
      conditions?: string;
      active?: boolean;
    },
  ): Promise<DelegationPolicyRecord | null>;

  /**
   * Soft-delete: sets active=false for all active policies matching businessId + scope.
   * Returns { count } — the number of rows affected (0 when none matched).
   */
  softDeleteByScope(businessId: string, scope: string): Promise<{ count: number }>;
}

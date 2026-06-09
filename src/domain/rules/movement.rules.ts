// Business rules for cash movements — pure functions, no UI, no framework dependencies

// Hard block — movement amount must be > 0
export function validateMovementAmount(amount: number): string | null {
  if (!Number.isFinite(amount) || amount <= 0) return "Movement amount must be greater than zero.";
  return null;
}

// Hard block — movement must have a description
export function validateMovementDescription(description: string): string | null {
  if (!description || description.trim().length === 0) return "Movement description is required.";
  return null;
}

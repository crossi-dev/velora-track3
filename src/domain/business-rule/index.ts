// Barrel para src/domain/business-rule.
// Re-exporta el engine y sus tipos. La definición de BusinessRule sigue
// viviendo en src/domain/business-rule.ts (legacy path) hasta que se decida
// consolidar. Importar desde "@/domain/business-rule/policy-engine" para el
// motor.

export * from "./policy-engine";

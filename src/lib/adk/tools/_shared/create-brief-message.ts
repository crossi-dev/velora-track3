// create-brief-message.ts
//
// Structured brief envelope for Supervisor -> sub-agent A2A messages (GAP2 fix).
//
// Addresses GAP2: without explicit structure, the Supervisor sends raw LLM prose
// and sub-agents have no grounding for constraints, expected output shape, or
// failure behaviour. This envelope adds a thin delimiter block the sub-agent LLM
// can follow while remaining backward-compatible (the objective field carries the
// original free-text message unchanged).
//
// Extracted from create-a2a-agent-tool.ts to keep the factory file under the
// 300-line code size contract (CLAUDE.md "Code Size Contract").
//
// Source: Google ADK multi-agent best practices
// https://google.github.io/adk-docs/multi-agents/

/**
 * Options for createBriefMessage -- the structured A2A brief envelope.
 */
export interface BriefMessageOptions {
  /** businessId for the tenant owning this request. */
  businessId: string;
  /**
   * The task objective -- typically the Supervisor args.message verbatim.
   * The sub-agent must accomplish exactly this.
   */
  objective: string;
  /**
   * Hard constraints the sub-agent MUST honour.
   * Defaults to the universal Velora constraint set when not provided.
   */
  constraints?: string[];
  /**
   * Description of the expected output shape/format.
   * Default: free-form plain text reply addressed to the owner.
   */
  outputFormat?: string;
  /**
   * What the sub-agent must do when it cannot fulfil the objective.
   * Default: respond honestly in plain text, do not invent data.
   */
  failureInstruction?: string;
  /**
   * Optional extra header lines prepended before the envelope (e.g. customerPhone).
   * Each entry is emitted verbatim as "key: value".
   */
  extraHeaders?: Record<string, string>;
}

/**
 * Default hard constraints injected into every A2A brief unless overridden.
 * Covers the most common hallucination / data-integrity failure modes seen in
 * Velora production logs (invented saleIds, fabricated amounts, phantom customers).
 */
export const DEFAULT_CONSTRAINTS: readonly string[] = [
  "NUNCA inventes IDs, montos, nombres de producto, precios o cualquier dato -- usa SOLO lo que esta en el contexto.",
  "Si falta informacion necesaria para completar la tarea, declaralo explicitamente en lugar de asumir.",
  "No ejecutes operaciones destructivas (borrar, modificar permanentemente) sin confirmacion explicita.",
  "Responde siempre en el idioma del objetivo (espanol rioplatense).",
];

/**
 * Wraps a sub-agent message in a structured brief envelope.
 *
 * Produces a delimited block:
 *
 *   businessId: <id>
 *   [extraHeaders...]
 *   <<<BRIEF>>>
 *   ## OBJECTIVE
 *   <objective>
 *   ## CONSTRAINTS
 *   - ...
 *   ## OUTPUT FORMAT
 *   <outputFormat>
 *   ## ON FAILURE
 *   <failureInstruction>
 *   <<<END BRIEF>>>
 *
 * The envelope is LLM-readable plain text -- sub-agents that parse free-form
 * already benefit from the structure; future structured parsers can key on the
 * <<<BRIEF>>> / <<<END BRIEF>>> delimiters.
 */
export function createBriefMessage(opts: BriefMessageOptions): string {
  const {
    businessId,
    objective,
    constraints = DEFAULT_CONSTRAINTS,
    outputFormat = "Texto plano dirigido al dueno del negocio. Conciso y accionable.",
    failureInstruction = "Responde honestamente que no podes completar la tarea con la informacion disponible. No inventes datos.",
    extraHeaders,
  } = opts;

  const headerLines = [`businessId: ${businessId}`];
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      headerLines.push(`${k}: ${v}`);
    }
  }

  const constraintLines = constraints.map((c) => `- ${c}`).join("\n");

  // Sanitize the objective: it carries the Supervisor's LLM-forwarded (and thus
  // user-influenced) message. Strip the envelope delimiters so a crafted message
  // ("...<<<END BRIEF>>> ## OBJECTIVE ...") cannot close the envelope early and
  // push the CONSTRAINTS section outside it (jd/supervisor-gap2-briefs WARNING).
  const safeObjective = objective.replace(/<<<|>>>/g, "");

  return (
    headerLines.join("\n") +
    "\n<<<BRIEF>>>\n" +
    "## OBJECTIVE\n" +
    safeObjective +
    "\n## CONSTRAINTS\n" +
    constraintLines +
    "\n## OUTPUT FORMAT\n" +
    outputFormat +
    "\n## ON FAILURE\n" +
    failureInstruction +
    "\n<<<END BRIEF>>>"
  );
}

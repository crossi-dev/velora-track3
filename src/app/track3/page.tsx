// Always-English judge landing page for the Google for Startups
// AI Agents Challenge — Track 3. Bypass i18n; this URL is for evaluators
// who may or may not speak Spanish.
//
// Linked from docs/SUBMISSION_DESCRIPTION.md and from the email sent to the program
// organizer. Designed as a 60-second tour: what Velora is, what's in
// scope for Track 3, how to verify the architecture, and where to go
// next (live demo, source code, docs).

import Link from "next/link";

export const metadata = {
  title: "Velora · Track 3 Submission · Google for Startups AI Agents Challenge",
  description:
    "Velora's submission to Track 3 — a multi-agent orchestration system built on Google ADK, Vertex AI, A2A protocol, Vertex AI Search grounding, pgvector RAG, and Vertex Agent Engine. Production live on Cloud Run.",
};

const REPO = "https://github.com/crossi-dev/velora";

// NOTE: when bumping Gemini models in src/lib/gemini-models.ts, update the
// `detail` strings below so the public Track 3 page stays in sync.
const MANDATORY_TECH = [
  {
    label: "Vertex AI Gemini",
    detail: "Gemini 2.5 Flash (Companion / Employee) + Gemini 2.5 Pro (Supervisor). Exclusive — no direct OpenAI/Anthropic in the request path. Cloud Run env overrides code defaults; Cloud Run is source of truth.",
    proof: `${REPO}/blob/main/src/lib/adk/gemini-config.ts`,
  },
  {
    label: "Google ADK",
    detail: "Both Employee and Supervisor wrapped as ADK Agent instances. TypeScript on Cloud Run, Python ADK on Vertex Agent Engine.",
    proof: `${REPO}/tree/main/src/lib/adk`,
  },
  {
    label: "Cloud Run",
    detail: "Production deployment in southamerica-east1. Min-instances=1 temporarily for contest demo period; scale-to-zero is the standard architecture (see cloudbuild-dockerfile.yaml line 70).",
    proof: `${REPO}/blob/main/cloudbuild-dockerfile.yaml`,
  },
  {
    label: "Vertex AI Agent Engine",
    detail: "ReasoningEngine deployed at projects/000000000000/locations/us-central1/reasoningEngines/REASONING_ENGINE_ID.",
    proof: `${REPO}/tree/main/agent-engine`,
  },
  {
    label: "A2A protocol v0.3.0",
    detail: "Agent card discoverable at /.well-known/agent-card.json. Pub/Sub transport for async events.",
    proof: "https://somosvelora.com/.well-known/agent-card.json",
  },
  {
    label: "Vertex AI Search grounding",
    detail: "Per-tenant Discovery Engine datastores. Resolves Argentine regional synonyms (destornillador ↔ desarmador) the SQL fuzzy matcher misses. Implemented and wired; feature-flagged (`USE_VERTEX_SEARCH`); disabled in the current production deployment, enable via the flag once per-tenant datastores are provisioned.",
    proof: `${REPO}/blob/main/src/lib/vertex-search.ts`,
  },
  {
    label: "pgvector RAG",
    detail: "Vertex text-embedding-004 (768-dim) on Supabase Postgres for semantic recall. Tenant-isolated. Implemented and wired; feature-flagged (`USE_EMBEDDINGS`); disabled in the current production deployment, enable via the flag.",
    proof: `${REPO}/blob/main/src/lib/semantic-recall.ts`,
  },
  {
    label: "Multi-agent collaboration",
    detail: "Sale → Pub/Sub LOW_STOCK event → Supervisor decision → Web push to owner. Single-agent cannot deliver this without 4-5s latency on every cashier turn.",
    proof: `${REPO}/blob/main/docs/SUBMISSION_DESCRIPTION.md#multi-agent-system`,
  },
];

const QUICK_LINKS = [
  {
    label: "Live demo",
    href: "https://somosvelora.com",
    note: "The cashier-facing application. Spanish-first by design (Argentine SMB target market).",
  },
  {
    label: "Public agent card",
    href: "https://somosvelora.com/.well-known/agent-card.json",
    note: "A2A protocol v0.3.0 declaration with skills, contracts, and security schemes.",
  },
  {
    label: "Source code (GitHub)",
    href: REPO,
    note: "Public repo. See docs/CONTEST_PERIOD_WORK.md for the file/commit delineation of submission scope.",
  },
  {
    label: "Submission writeup",
    href: `${REPO}/blob/main/docs/SUBMISSION_DESCRIPTION.md`,
    note: "Pitch + Mandatory Technologies + Innovation highlights + Why multi-agent over single-agent.",
  },
  {
    label: "Architecture diagram",
    href: `${REPO}/blob/main/docs/ARCHITECTURE.md`,
    note: "Mermaid diagram of the full multi-agent system + A2A bus.",
  },
  {
    label: "Mandatory tech audit",
    href: `${REPO}/blob/main/docs/SUBMISSION_DESCRIPTION.md#track-3-mandate-compliance`,
    note: "Per-requirement evidence with file paths + line numbers.",
  },
  {
    label: "Submission scope (delineation)",
    href: `${REPO}/blob/main/docs/CONTEST_PERIOD_WORK.md`,
    note: "Files and commits authored during the Contest Period vs pre-existing Velora SaaS.",
  },
];

const styles = {
  page: {
    minHeight: "100dvh",
    fontFamily: "var(--font-dm-sans, system-ui, sans-serif)",
    background: "#faf9f6",
    color: "#1a1a1a",
    padding: "3rem 1.5rem",
    lineHeight: 1.6,
  } as const,
  wrap: {
    maxWidth: "920px",
    margin: "0 auto",
  } as const,
  hero: {
    marginBottom: "3rem",
  } as const,
  badge: {
    display: "inline-block",
    background: "#1a73e8",
    color: "white",
    padding: "0.25rem 0.75rem",
    borderRadius: "999px",
    fontSize: "0.875rem",
    fontWeight: 600,
    marginBottom: "1rem",
  } as const,
  h1: {
    fontFamily: "var(--font-fraunces, Georgia, serif)",
    fontSize: "clamp(2rem, 5vw, 3rem)",
    fontWeight: 700,
    margin: "0 0 1rem",
    lineHeight: 1.1,
  } as const,
  lede: {
    fontSize: "1.125rem",
    color: "#444",
    margin: "0 0 1.5rem",
    maxWidth: "70ch",
  } as const,
  cta: {
    display: "inline-block",
    background: "#1a1a1a",
    color: "white",
    padding: "0.875rem 1.5rem",
    borderRadius: "8px",
    fontSize: "1rem",
    fontWeight: 600,
    textDecoration: "none",
    marginRight: "0.75rem",
  } as const,
  ctaSecondary: {
    display: "inline-block",
    background: "transparent",
    color: "#1a1a1a",
    border: "1px solid #d0d0d0",
    padding: "0.875rem 1.5rem",
    borderRadius: "8px",
    fontSize: "1rem",
    fontWeight: 600,
    textDecoration: "none",
  } as const,
  section: {
    marginTop: "3rem",
  } as const,
  h2: {
    fontFamily: "var(--font-fraunces, Georgia, serif)",
    fontSize: "1.75rem",
    fontWeight: 700,
    margin: "0 0 1rem",
  } as const,
  card: {
    background: "white",
    border: "1px solid #ebe9e1",
    borderRadius: "12px",
    padding: "1rem 1.25rem",
    marginBottom: "0.75rem",
  } as const,
  cardLabel: {
    fontWeight: 600,
    fontSize: "1rem",
    margin: "0 0 0.25rem",
  } as const,
  cardDetail: {
    color: "#555",
    margin: "0 0 0.5rem",
    fontSize: "0.9375rem",
  } as const,
  link: {
    color: "#1a73e8",
    fontSize: "0.875rem",
    textDecoration: "none",
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
  } as const,
  linkRow: {
    display: "block",
    background: "white",
    border: "1px solid #ebe9e1",
    borderRadius: "8px",
    padding: "0.875rem 1rem",
    marginBottom: "0.5rem",
    textDecoration: "none",
    color: "#1a1a1a",
  } as const,
  linkLabel: {
    fontWeight: 600,
    fontSize: "1rem",
  } as const,
  linkNote: {
    color: "#666",
    fontSize: "0.875rem",
    margin: "0.125rem 0 0",
  } as const,
  footer: {
    marginTop: "4rem",
    paddingTop: "2rem",
    borderTop: "1px solid #ebe9e1",
    color: "#666",
    fontSize: "0.875rem",
  } as const,
};

export default function Track3SubmissionPage() {
  return (
    <main style={styles.page}>
      <div style={styles.wrap}>
        <section style={styles.hero}>
          <span style={styles.badge}>Track 3 · Google for Startups AI Agents Challenge</span>
          <h1 style={styles.h1}>Velora — A2A interoperability layer for multi-agent enterprise coordination.</h1>
          <p style={styles.lede}>
            Cashiers in Argentina type <em>&ldquo;vendí 2 cubiertas Firestone&rdquo;</em> into a chat and Velora&apos;s
            Employee Agent (Gemini 2.5 Flash via Vertex AI) registers the sale, infers the rest, and
            confirms in under 1.8 seconds. Behind the scenes, a Supervisor Agent (Gemini 2.5 Pro)
            watches every event through an A2A bus and notifies the owner only when something
            matters. Two agents, distinct voices, separated by latency contract.
          </p>
          <Link href="https://somosvelora.com" style={styles.cta}>
            Open the live demo →
          </Link>
          <Link href={REPO} style={styles.ctaSecondary}>
            View source on GitHub
          </Link>
        </section>

        <section style={styles.section}>
          <h2 style={styles.h2}>Mandatory technologies</h2>
          <p style={{ color: "#555", marginBottom: "1.5rem" }}>
            All eight Track 3 mandatory technologies are implemented. Five are active in
            production; three are implemented and wired but feature-flagged for cost control
            (`USE_VERTEX_SEARCH`, `USE_EMBEDDINGS`, `USE_AGENT_ENGINE`).
            Each item below links to evidence (file, line number, or live endpoint).
          </p>
          {MANDATORY_TECH.map((item) => (
            <div key={item.label} style={styles.card}>
              <p style={styles.cardLabel}>{item.label}</p>
              <p style={styles.cardDetail}>{item.detail}</p>
              <a href={item.proof} style={styles.link} target="_blank" rel="noopener noreferrer">
                {item.proof.replace(/^https?:\/\//, "")}
              </a>
            </div>
          ))}
        </section>

        <section style={styles.section}>
          <h2 style={styles.h2}>Submission scope</h2>
          <p style={{ color: "#555", marginBottom: "1.5rem" }}>
            Velora is a pre-existing Argentine SMB SaaS. The Track 3 submission is the multi-agent
            orchestration layer authored exclusively during the Contest Period: ADK wrappers, A2A
            protocol, Vertex AI Search grounding, pgvector RAG, and Agent Engine deployment. See
            the delineation document below for exact files, first-commit dates, and verification
            commands a judge can run.
          </p>
          {QUICK_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              style={styles.linkRow}
            >
              <div style={styles.linkLabel}>{link.label} →</div>
              <p style={styles.linkNote}>{link.note}</p>
            </a>
          ))}
        </section>

        <section style={styles.section}>
          <h2 style={styles.h2}>How to evaluate in 60 seconds</h2>
          <ol style={{ color: "#444", paddingLeft: "1.5rem" }}>
            <li>
              Open the live demo at{" "}
              <a href="https://somosvelora.com" style={{ ...styles.link, fontFamily: "inherit" }}>
                somosvelora.com
              </a>
              . The landing page is in Spanish (the product&apos;s target market). The language
              switcher on the landing page toggles between Spanish and English. The cashier UI
              requires authentication — contact owner@example.com for access credentials.
            </li>
            <li>
              Hit{" "}
              <a
                href="https://somosvelora.com/.well-known/agent-card.json"
                style={{ ...styles.link, fontFamily: "inherit" }}
              >
                /.well-known/agent-card.json
              </a>{" "}
              to see the A2A protocol declaration with two skills (supervisor, employee-event-router)
              and contracts.
            </li>
            <li>
              Read{" "}
              <a
                href={`${REPO}/blob/main/docs/SUBMISSION_DESCRIPTION.md`}
                style={{ ...styles.link, fontFamily: "inherit" }}
              >
                docs/SUBMISSION_DESCRIPTION.md
              </a>{" "}
              for the pitch and the &ldquo;why multi-agent&rdquo; section.
            </li>
            <li>
              Verify Contest Period scope by running the git log command in{" "}
              <a
                href={`${REPO}/blob/main/docs/CONTEST_PERIOD_WORK.md`}
                style={{ ...styles.link, fontFamily: "inherit" }}
              >
                docs/CONTEST_PERIOD_WORK.md
              </a>{" "}
              against a fresh clone.
            </li>
          </ol>
        </section>

        <footer style={styles.footer}>
          <p>
            Submitted by Carlos Rossi · entrant ·{" "}
            <a href="mailto:owner@example.com" style={styles.link}>
              owner@example.com
            </a>
          </p>
          <p>
            Submission video: see{" "}
            <a href={`${REPO}/blob/main/docs/SUBMISSION_DESCRIPTION.md`} style={styles.link}>
              docs/SUBMISSION_DESCRIPTION.md
            </a>{" "}
            (recording pending).
          </p>
        </footer>
      </div>
    </main>
  );
}

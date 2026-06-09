-- Tappable chips for assistant messages — supervisor emits structured
-- quick-reply options at onboarding T2/T3/T5/post-T6 instead of inline
-- text. JSON shape: { kind: "single"|"multi"|"action", options: [...] }.
-- Nullable for back-compat: existing rows and any reply without chips
-- continue to render exactly as before.
ALTER TABLE "ChatMessage" ADD COLUMN "chips" JSONB;

// Shared detection for WhatsApp auto-send intent in sale commands.
// Used by:
//   - Server pre-model-router sale+send deterministic branch
//   - Server post-model register_sale handler (autoSend flag)
//   - Client command parser short-circuit (velora-command-parser consumer)
// Keep this as the single source of truth; never inline these regexes.

// 80-keyword curated list covering Spanish/Argentine variants for "send via
// WhatsApp". Grouped for readability; all entries are lowercase + accent-free
// so callers only need to lowercase the input. If you find a missing variant
// in a real user message, add it here — do NOT add it inline at the call site.
const SEND_KEYWORDS = [
  // WhatsApp full word + common typos (12)
  "whatsapp", "whatssap", "whatsap", "whatsa", "whasap", "whasapp",
  "wasap", "wassap", "wasapp", "watsap", "watsapp", "whats",
  // Short codes / abbreviations (12)
  "wpp", "wsp", "wap", "wapp", "wp", "ws", "wa", "wts", "wsap", "wppp", "guasap", "guasapp",
  // mandar — imperatives + clitics (22)
  "manda", "mandar", "mandale", "mandalo", "mandala", "mandales", "mandalas", "mandalos",
  "mandasela", "mandaselo", "mandaselos", "mandamela", "mandamelo", "mandarsela",
  "mandarselo", "mandarle", "mandarlo", "mandarla", "mandarles", "mandalela",
  "madale", "maddale",
  // enviar — imperatives + clitics (16)
  "envia", "enviar", "enviale", "enviame", "envialo", "enviala", "enviales",
  "enviarle", "enviarlo", "enviarla", "enviarles", "enviaselo", "enviasela",
  "enviaselos", "enviarsela", "enviarselo",
  // pasar — slang send (8)
  "pasale", "pasalo", "pasala", "pasales", "pasame", "pasamelo", "pasamela", "pasasela",
  // tirar — argot (5)
  "tirale", "tiramelo", "tirasela", "tiraselo", "tiramela",
  // canal / direccion (5)
  "directo", "directamente", "mensaje", "msj", "msg",
];

const SEND_KEYWORDS_ALT = SEND_KEYWORDS.join("|");
const SEND_KEYWORDS_RE = new RegExp(`\\b(${SEND_KEYWORDS_ALT})\\b`);

// Accepts the raw user text (pre- or post-normalization). We do a cheap
// lower-case normalization here so callers don't have to. Accent stripping
// isn't needed because every keyword is already accent-free.
export function containsSendKeyword(text: string): boolean {
  if (!text) return false;
  return SEND_KEYWORDS_RE.test(text.toLowerCase());
}

// Strips trailing send-keyword phrases from a customer name fragment so
// "carlos mandale wpp" → "carlos". Without this, the customer matcher gets
// the whole phrase and fails to find the contact, falling through to the
// server with ambiguousCustomer=true and no Confirmar card. Matches the
// keyword and any token that follows ("mandale wpp", "envialo whatsapp",
// "manda whats", etc.) up to end-of-string.
const SEND_TAIL_RE = new RegExp(
  `[\\s,]+(?:${SEND_KEYWORDS_ALT})(?:\\s+\\S+)*\\s*$`,
  "i"
);

export function stripSendKeywordTail(customerFragment: string): string {
  if (!customerFragment) return customerFragment;
  return customerFragment.replace(SEND_TAIL_RE, "").trim();
}

import { WhatsappLogo, Check } from "@phosphor-icons/react/dist/ssr";

// Official Google multi-color G logo per Google Identity Services brand
// guidelines. Wrapped in a white circle so it remains legible on both the
// default brand-color button and the white-on-brand CtaBand button.
export function GoogleIcon() {
  return (
    <span className="lp-gicon" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 48 48" focusable="false">
        <path fill="#4285F4" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.6 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C33.9 6 29.2 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.4-.4-3.5z" />
        <path fill="#34A853" d="M6.3 14.7l6.6 4.8C14.6 16.1 19 13 24 13c3 0 5.8 1.1 7.9 3l5.7-5.7C33.9 6 29.2 4 24 4 16.3 4 9.6 8.4 6.3 14.7z" />
        <path fill="#FBBC05" d="M24 44c5.1 0 9.7-1.9 13.2-5.1l-6.1-5c-2 1.4-4.5 2.1-7.1 2.1-5.3 0-9.7-3.4-11.3-8.1l-6.5 5C9.4 39.6 16.1 44 24 44z" />
        <path fill="#EA4335" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4.2 5.5l6.1 5C40.9 35.6 44 30.3 44 24c0-1.2-.1-2.4-.4-3.5z" />
      </svg>
    </span>
  );
}

// Spinner shown while the OAuth roundtrip is in progress.
// Default stroke is light (rgba(255,255,255,0.9)) for use on dark-background buttons.
// Pass variant="dark" explicitly at every call site where the button background is
// light / brand-blue (#8AB0F0) so the spinner contrasts correctly against it.
export function SpinnerIcon({ variant }: { variant?: "dark" }) {
  const stroke = variant === "dark" ? "#02060F" : "rgba(255, 255, 255, 0.9)";
  return (
    <svg
      className="lp-spinner"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke={stroke} strokeOpacity="0.3" strokeWidth="2.5" />
      <path d="M12 3a9 9 0 0 1 9 9" stroke={stroke} strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export function WhatsAppIcon() {
  return <WhatsappLogo size={18} weight="fill" aria-hidden />;
}

export function CheckIcon() {
  return <Check size={16} weight="bold" aria-hidden />;
}

import type { ReactNode } from "react";
import Image from "next/image";
import styles from "./cobro-result.module.css";

export type CobroVariant = "success" | "failure" | "pending";

interface CobroResultProps {
  variant: CobroVariant;
  headline: string;
  body: ReactNode;
  paymentId?: string | null;
}

const ICON: Record<CobroVariant, string> = {
  success: "✅",
  failure: "⚠️",
  pending: "⏳",
};

const BADGE_CLASS: Record<CobroVariant, string> = {
  success: styles.badgeSuccess,
  failure: styles.badgeFailure,
  pending: styles.badgePending,
};

export function CobroResult({
  variant,
  headline,
  body,
  paymentId,
}: CobroResultProps) {
  return (
    <main className={styles.page} id="main-content">
      <div className={styles.card}>
        {/* Wordmark header */}
        <header className={styles.header}>
          <Image
            src="/velora-mark.svg"
            alt="Velora"
            width={28}
            height={28}
            className={styles.mark}
            priority
          />
          <span className={styles.wordmark}>Velora</span>
        </header>

        {/* Status icon badge */}
        <div className={`${styles.badge} ${BADGE_CLASS[variant]}`}>
          <span role="img" aria-hidden="true" className={styles.badgeIcon}>
            {ICON[variant]}
          </span>
        </div>

        {/* Headline + body copy */}
        <div className={styles.content}>
          <h1 className={styles.headline}>{headline}</h1>
          <p className={styles.body}>{body}</p>
        </div>

        {/* Optional payment reference */}
        {paymentId != null && paymentId !== "" && (
          <p className={styles.ref}>Ref. de pago: {paymentId}</p>
        )}
      </div>
    </main>
  );
}

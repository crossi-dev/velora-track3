"use client";

import Image from "next/image";
import styles from "./login.module.css";

interface FormHeroProps {
  businessName?: string | null;
  showBusinessCodeHelp?: boolean;
}

export function FormHero({ businessName, showBusinessCodeHelp }: FormHeroProps) {
  return (
    <>
      <div className={styles.hero}>
        <Image
          src="/velora-mark.svg"
          alt="Velora"
          width={32}
          height={32}
          className={styles.heroMark}
          priority
        />
        <p className={styles.heroHeading}>Tu turno empieza acá</p>
        <p className={styles.heroTagline}>Velora — tu negocio AI</p>
      </div>

      {businessName && (
        <div className={styles.bizHeader} style={{ padding: "1rem 1.5rem 0" }}>
          <p className={styles.bizSubtext}>
            <span className={styles.bizName}>{businessName}</span> te invita a
            que te sumes a su staff.
          </p>
        </div>
      )}

      {showBusinessCodeHelp && (
        <div className={styles.bizHeader} style={{ padding: "1rem 1.5rem 0" }}>
          <p className={styles.bizSubtext}>
            Ingresá el código que te pasó tu jefe. Si tenés un link de acceso, usalo directamente — ya incluye el código.
          </p>
        </div>
      )}
    </>
  );
}

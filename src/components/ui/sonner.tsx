"use client"

import { Toaster as Sonner, type ToasterProps } from "sonner"

// Velora uses a custom data-theme attribute (set via THEME_BOOT_SCRIPT in layout.tsx)
// rather than next-themes. We default to "system" so Sonner auto-detects the OS
// preference; the Velora token overrides below ensure the toast surface matches
// the design system regardless.
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="system"
      className="toaster group"
      position="bottom-center"
      style={
        {
          "--normal-bg": "var(--surface)",
          "--normal-text": "var(--tone-strong)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }

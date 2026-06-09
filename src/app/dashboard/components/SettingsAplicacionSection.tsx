"use client";

import { handleSignOut } from "@/lib/handle-sign-out";
import { type AppSettings } from "../lib/appSettings";
import { useDashboardLang } from "../lib/DashboardLangContext";
import { Button } from "@/components/ui/button";
import { SettingsMemoryCard } from "./SettingsMemoryCard";
import { useRole } from "../lib/contexts";
import {
  LABEL_STYLE,
  CARD_CLASS,
  CARD_STYLE,
  CARD_TITLE_STYLE,
  TOGGLE_ROW_STYLE,
  TOGGLE_LABEL_STYLE,
  Toggle,
  SegmentControl,
} from "./SettingsShared";

interface SettingsAplicacionSectionProps {
  appSettings: AppSettings;
  updateApp: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export function SettingsAplicacionSection({ appSettings, updateApp }: SettingsAplicacionSectionProps) {
  const { lang, setLang, t } = useDashboardLang();
  const role = useRole();
  const isOwner = role === "owner";
  return (
    <div className="flex flex-col gap-4">
      {/* ── Card 1: Apariencia ── */}
      <div className={CARD_CLASS} style={CARD_STYLE}>
        <p style={CARD_TITLE_STYLE}>{t("Appearance", "Apariencia")}</p>
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-col gap-1">
            <span style={LABEL_STYLE}>{t("Theme", "Tema")}</span>
            <SegmentControl
              options={[
                { value: "light" as const, label: t("Light", "Claro") },
                { value: "dark" as const, label: t("Dark", "Oscuro") },
                { value: "auto" as const, label: t("Automatic", "Automático") },
              ]}
              value={appSettings.theme}
              onChange={(v) => updateApp("theme", v)}
            />
          </div>
        </div>
      </div>

      {/* ── Card 2: Chat y voz ── */}
      <div className={CARD_CLASS} style={CARD_STYLE}>
        <p style={CARD_TITLE_STYLE}>{t("Chat & voice", "Chat y voz")}</p>
        <div className="flex flex-col gap-2.5">
          <div style={TOGGLE_ROW_STYLE}>
            <span style={TOGGLE_LABEL_STYLE}>{t("Show assistant suggestions", "Mostrar sugerencias del asistente")}</span>
            <Toggle checked={appSettings.showAssistantSuggestions} onChange={(v) => updateApp("showAssistantSuggestions", v)} label={t("Show assistant suggestions", "Mostrar sugerencias del asistente")} />
          </div>
          <div style={TOGGLE_ROW_STYLE}>
            <span style={TOGGLE_LABEL_STYLE}>{t("Enable voice recording", "Habilitar grabación de voz")}</span>
            <Toggle checked={appSettings.voiceEnabled} onChange={(v) => updateApp("voiceEnabled", v)} label={t("Enable voice recording", "Habilitar grabación de voz")} />
          </div>
        </div>
      </div>

      {/* ── Card 3: Comportamiento ── */}
      <div className={CARD_CLASS} style={CARD_STYLE}>
        <p style={CARD_TITLE_STYLE}>{t("Behavior", "Comportamiento")}</p>
        <div className="flex flex-col gap-2.5">
          <div style={TOGGLE_ROW_STYLE}>
            <span style={TOGGLE_LABEL_STYLE}>{t("Always open on Home", "Abrir siempre en Inicio")}</span>
            <Toggle checked={appSettings.alwaysOpenMain} onChange={(v) => updateApp("alwaysOpenMain", v)} label={t("Always open on Home", "Abrir siempre en Inicio")} />
          </div>
          <div style={TOGGLE_ROW_STYLE}>
            <span style={TOGGLE_LABEL_STYLE}>{t("Show low stock alerts", "Mostrar alertas de stock bajo")}</span>
            <Toggle checked={appSettings.showLowStockAlerts} onChange={(v) => updateApp("showLowStockAlerts", v)} label={t("Show low stock alerts", "Mostrar alertas de stock bajo")} />
          </div>
        </div>
      </div>

      {/* ── Card 4: Idioma / Language ── */}
      <div className={CARD_CLASS} style={CARD_STYLE}>
        <p style={CARD_TITLE_STYLE}>{t("Language", "Idioma")}</p>
        <div className="flex flex-col gap-1">
          <span style={LABEL_STYLE}>{t("App language", "Idioma de la app")}</span>
          <SegmentControl
            options={[
              { value: "es-AR" as const, label: t("Spanish", "Español") },
              { value: "en" as const, label: t("English", "Inglés") },
            ]}
            value={lang}
            onChange={(v) => setLang(v as "es-AR" | "en")}
          />
        </div>
      </div>

      {/* ── Card 5: Memorias de Velora (owner only, hidden when flag off) ── */}
      {isOwner && <SettingsMemoryCard t={t} lang={lang} />}

      {/* ── Card 6: Cuenta ── */}
      <div className={CARD_CLASS} style={CARD_STYLE}>
        <p style={CARD_TITLE_STYLE}>{t("Account", "Cuenta")}</p>
        <Button
          type="button"
          variant="outline"
          size="lg"
          onClick={() => { void handleSignOut(); }}
          className="text-[var(--danger)] border-[var(--danger)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
        >
          {t("Sign out", "Cerrar sesión")}
        </Button>
      </div>
    </div>
  );
}

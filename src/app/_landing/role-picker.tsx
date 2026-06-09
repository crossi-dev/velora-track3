"use client";

import { Buildings } from "@phosphor-icons/react/dist/ssr";
import { GoogleIcon, SpinnerIcon } from "./icons";
import type { LandingDict } from "./i18n";

export function RolePicker({
  onSignIn,
  isSigningIn,
  dict,
}: {
  onSignIn: () => void;
  isSigningIn?: boolean;
  dict: LandingDict;
}) {
  const rp = dict.rolePicker;

  return (
    <div className="lp-role-cards" role="group" aria-label={rp.groupLabel}>
      {/* Soy dueño */}
      <button
        type="button"
        onClick={onSignIn}
        disabled={isSigningIn}
        aria-disabled={isSigningIn}
        className="lp-role-card lp-role-card--owner"
        aria-label={rp.ownerAriaLabel}
      >
        <span className="lp-role-icon lp-role-icon--owner" aria-hidden="true">
          <Buildings size={22} weight="fill" />
        </span>
        <span className="lp-role-label lp-role-label--fraunces">{rp.ownerLabel}</span>
        <span className="lp-role-sub">
          {isSigningIn ? (
            <>
              <SpinnerIcon variant="dark" />
              {" Conectando…"}
            </>
          ) : (
            <>
              <GoogleIcon />
              {rp.ownerSub}
            </>
          )}
        </span>
      </button>
    </div>
  );
}

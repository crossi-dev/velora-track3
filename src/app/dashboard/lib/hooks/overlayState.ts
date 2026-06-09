/**
 * Singleton ref that tracks whether any overlay (BottomSheet, modal, etc.)
 * is currently open on the Android Capacitor build.
 *
 * Used to prevent the global back-button handler from firing a minimize/tab-switch
 * when a sheet has ALREADY handled the event and closed itself. Both the sheet
 * and the global handler read/write this ref within the same JS frame, so no
 * coordination across async boundaries is needed.
 */
export const overlayOpenRef = { current: false };

"use client";

import { useTheme } from "next-themes";
import { useEffect } from "react";
import { THEME_COLORS } from "./theme-colors";

/**
 * Keeps the browser's title bar (Safari web apps, installed PWAs, mobile toolbars) the same colour as the page.
 * The static theme-color tags follow the system appearance; this overrides them when someone picks light or dark
 * in Unifeye, so a dark page doesn't sit under a light title bar.
 */
export function ThemeColor() {
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    if (resolvedTheme !== "light" && resolvedTheme !== "dark") return;
    const color = THEME_COLORS[resolvedTheme];
    const tags = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
    for (const tag of tags) tag.content = color;
  }, [resolvedTheme]);
  return null;
}

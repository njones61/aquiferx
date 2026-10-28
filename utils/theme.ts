/**
 * Light and dark, for the whole app.
 *
 * Every color the app paints is a CSS variable: the panel tokens in index.css
 * and the Tailwind palette in tailwind.config.js both hold a light set on :root
 * and a dark set under :root[data-theme="dark"]. A theme change is that one
 * attribute on <html>. The exceptions are colors drawn in JavaScript, such as a
 * canvas, which subscribe with onThemeChange or useTheme.
 *
 * Light is the default. index.html applies a remembered choice before first
 * paint, so a dark-mode user never sees a flash of light; initTheme here picks
 * it up.
 */

import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'aqx-theme';

let current: Theme = 'light';
const listeners = new Set<(t: Theme) => void>();

function applyTheme(theme: Theme) {
  current = theme === 'dark' ? 'dark' : 'light';
  if (current === 'light') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = current;
  for (const fn of listeners) fn(current);
}

export function setTheme(theme: Theme) {
  applyTheme(theme);
  try {
    localStorage.setItem(STORAGE_KEY, current);
  } catch { /* private mode: the choice lasts until the tab closes */ }
}

export const getTheme = () => current;

export function onThemeChange(fn: (t: Theme) => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function initTheme() {
  let saved: string | null = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* ignore */ }
  applyTheme(saved === 'dark' ? 'dark' : 'light');
}

/** The current theme, re-rendering the caller when it changes. */
export const useTheme = () => useSyncExternalStore(onThemeChange, getTheme);

/** A CSS variable's value as the current theme sets it, for drawing in JavaScript. */
export const cssVar = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

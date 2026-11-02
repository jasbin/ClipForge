"use client";

import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { cx } from "./ui";

type Theme = "system" | "light" | "dark";
const KEY = "clipforge-theme";

/** Runs before paint (inlined in <head>) so the stored theme never flashes. */
export const themeScript = `try{var t=localStorage.getItem("${KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    try {
      const t = localStorage.getItem(KEY);
      if (t === "light" || t === "dark") setTheme(t);
    } catch {}
  }, []);

  function choose(t: Theme) {
    setTheme(t);
    const root = document.documentElement;
    if (t === "system") delete root.dataset.theme;
    else root.dataset.theme = t;
    try {
      if (t === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, t);
    } catch {}
  }

  const options = [
    { value: "light", label: "Light", icon: Icon.Sun },
    { value: "system", label: "System", icon: Icon.Monitor },
    { value: "dark", label: "Dark", icon: Icon.Moon },
  ] as const;

  return (
    <div role="radiogroup" aria-label="Theme" className="flex rounded-lg bg-surface-2 p-0.5">
      {options.map(({ value, label, icon: I }) => (
        <button key={value} role="radio" aria-checked={theme === value} title={label} aria-label={label}
          onClick={() => choose(value)}
          className={cx("grid h-7 w-7 cursor-pointer place-items-center rounded-md transition-colors",
            theme === value ? "bg-surface text-fg shadow-card" : "text-muted hover:text-fg")}>
          <I width={14} height={14} />
        </button>
      ))}
    </div>
  );
}

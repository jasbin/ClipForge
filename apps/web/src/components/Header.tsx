"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api, type Health } from "@/lib/api";
import { Icon } from "./icons";
import { ThemeToggle } from "./ThemeToggle";
import { cx } from "./ui";

const NAV = [
  { href: "/", label: "Projects", match: (p: string) => p === "/" || p.startsWith("/projects") },
  { href: "/voices", label: "Voices", match: (p: string) => p.startsWith("/voices") },
  { href: "/music", label: "Music", match: (p: string) => p.startsWith("/music") },
];

export function Header() {
  const pathname = usePathname();
  const [health, setHealth] = useState<Health | null | undefined>(undefined);

  // Re-check the API regularly, faster while it's down, so the banner clears on its own.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = () =>
      api.health().then(
        (h) => { if (alive) { setHealth(h); timer = setTimeout(check, 30_000); } },
        () => { if (alive) { setHealth(null); timer = setTimeout(check, 4_000); } },
      );
    check();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-line bg-bg/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent text-on-accent">
              <Icon.Film width={15} height={15} />
            </span>
            <span className="text-[15px]">ClipForge</span>
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            {NAV.map((n) => {
              const active = n.match(pathname);
              return (
                <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined}
                  className={cx("rounded-md px-2.5 py-1.5 transition-colors",
                    active ? "bg-surface-2 font-medium text-fg" : "text-muted hover:text-fg")}>
                  {n.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden items-center gap-2 text-xs text-muted sm:flex"
              title={health ? `API connected · LLM: ${health.llm_provider} / ${health.llm_model}` : undefined}>
              <span className={cx("h-2 w-2 rounded-full",
                health ? "bg-success" : health === null ? "bg-danger" : "animate-pulse bg-line-strong")} />
              {health === undefined ? "Connecting…" : health ? <span className="font-mono">{health.llm_model}</span> : "API offline"}
            </span>
            <ThemeToggle />
          </div>
        </div>
      </header>
      {health === null && (
        <div role="alert" className="border-b border-danger/25 bg-danger-soft">
          <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2 text-sm text-danger">
            <Icon.Alert className="shrink-0" />
            <span>
              Can&apos;t reach the ClipForge API. Start it with <code className="rounded bg-surface px-1 font-mono text-xs">make dev</code>; this page reconnects automatically.
            </span>
          </div>
        </div>
      )}
    </>
  );
}

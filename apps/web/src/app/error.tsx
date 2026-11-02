"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Icon } from "@/components/icons";
import { Button, buttonClass } from "@/components/ui";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto grid max-w-lg place-items-center gap-4 px-4 py-24 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-danger-soft text-danger"><Icon.Alert width={20} height={20} /></span>
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-muted">{error.message || "An unexpected error occurred while rendering this page."}</p>
      <div className="flex gap-2">
        <Button variant="primary" onClick={reset} icon={<Icon.Refresh width={14} height={14} />}>Try again</Button>
        <Link href="/" className={buttonClass("secondary", "sm")}>Go to projects</Link>
      </div>
    </main>
  );
}

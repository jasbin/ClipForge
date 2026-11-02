import Link from "next/link";
import { buttonClass } from "@/components/ui";

export default function NotFound() {
  return (
    <main className="mx-auto grid max-w-lg place-items-center gap-3 px-4 py-24 text-center">
      <p className="font-mono text-sm text-muted">404</p>
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-muted">The page you&apos;re looking for doesn&apos;t exist.</p>
      <Link href="/" className={buttonClass("primary", "sm", "mt-2")}>Go to projects</Link>
    </main>
  );
}

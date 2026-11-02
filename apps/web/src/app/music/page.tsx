import type { Metadata } from "next";
import { MusicLibrary } from "@/components/MusicLibrary";

export const metadata: Metadata = { title: "Music" };

export default function MusicPage() {
  return (
    <main className="mx-auto grid max-w-4xl grid-cols-1 gap-8 px-4 py-10">
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">Music</h1>
        <p className="mt-2 text-muted">
          Background tracks to mix under your clips at export. Music automatically dips while someone is speaking,
          and fades in and out.
        </p>
      </div>
      <MusicLibrary />
    </main>
  );
}

import type { Metadata } from "next";
import { VoiceLibrary } from "@/components/VoiceLibrary";

export const metadata: Metadata = { title: "Voices" };

export default function VoicesPage() {
  return (
    <main className="mx-auto grid max-w-4xl grid-cols-1 gap-8 px-4 py-10">
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">Voices</h1>
        <p className="mt-2 text-muted">
          Voices for re-narrating clips with Qwen3-TTS. The default is preselected every time you re-voice a clip,
          and whichever voice you use becomes the new default.
        </p>
      </div>
      <VoiceLibrary />
    </main>
  );
}

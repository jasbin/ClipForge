import { NewProjectForm } from "@/components/NewProjectForm";
import { ProjectList } from "@/components/ProjectList";

export default function Home() {
  return (
    <main className="mx-auto grid max-w-5xl grid-cols-1 gap-12 px-4 py-10 sm:py-14">
      <section className="grid gap-6">
        <div className="max-w-2xl">
          <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Find the best clips in any video
          </h1>
          <p className="mt-3 text-muted text-pretty">
            Paste a link or upload a video. ClipForge transcribes it, scores every moment for hook,
            payoff and stand-alone sense, and hands you ranked, ready-to-cut clips.
          </p>
        </div>
        <NewProjectForm />
      </section>
      <ProjectList />
    </main>
  );
}

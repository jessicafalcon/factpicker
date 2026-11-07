export default function Loading() {
  return (
    <main className="flex-1 pb-28">
      <section className="mx-auto max-w-[1180px] px-6 pt-14 text-center md:pt-20">
        <div className="mx-auto h-3 w-56 animate-pulse rounded bg-rule/70" />
        <div className="mx-auto mt-8 h-16 w-[min(88vw,42rem)] animate-pulse rounded bg-rule/60" />
        <div className="mx-auto mt-10 h-4 w-[min(70vw,30rem)] animate-pulse rounded bg-rule/50" />
        <div className="mx-auto mt-3 h-4 w-[min(60vw,24rem)] animate-pulse rounded bg-rule/40" />
      </section>
      <section className="mx-auto mt-24 max-w-[1180px] px-6">
        <div className="h-8 w-64 animate-pulse rounded bg-rule/60" />
        <div className="mt-8 grid gap-10 md:grid-cols-[300px_minmax(0,1fr)]">
          <div className="aspect-[9/15] w-full max-w-[300px] animate-pulse rounded-2xl bg-rule/50" />
          <div className="space-y-3">
            <div className="h-6 w-full animate-pulse rounded bg-rule/50" />
            <div className="h-6 w-11/12 animate-pulse rounded bg-rule/50" />
            <div className="h-6 w-9/12 animate-pulse rounded bg-rule/40" />
          </div>
        </div>
      </section>
    </main>
  );
}

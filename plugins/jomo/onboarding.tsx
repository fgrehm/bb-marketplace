import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { LibrarianProfile } from "./server";

export type { LibrarianProfile };

type Answers = LibrarianProfile["answers"];
type MultiAnswerKey = "interests" | "research" | "missList";
type SingleAnswerKey = "savedMeaning" | "autonomy";

type Question = {
  key: MultiAnswerKey | SingleAnswerKey;
  kicker: string;
  title: string;
  why: string;
  options: string[];
  multi: boolean;
};

const QUESTIONS: Question[] = [
  {
    key: "interests",
    kicker: "positive space",
    title: "What are you unreasonably into right now?",
    why: "Not your permanent identity. Just the trails worth following today.",
    options: ["agents", "retro hardware", "coffee", "Salvador"],
    multi: true,
  },
  {
    key: "research",
    kicker: "the hoard",
    title: "What are you hoarding for future research?",
    why: "These can rest unread without becoming a debt you owe yourself.",
    options: ["personal archives", "local history", "systems papers", "repair notes"],
    multi: true,
  },
  {
    key: "missList",
    kicker: "the miss-list",
    title: "What would you happily never see again?",
    why: "Knowing what to miss matters as much as knowing what to keep.",
    options: ["crypto prices", "launch-hype threads", "AI thought-leadership", "VC discourse"],
    multi: true,
  },
  {
    key: "savedMeaning",
    kicker: "your verb",
    title: "When you save something, what does saved mean?",
    why: "JOMO will use your meaning instead of turning every bookmark into homework.",
    options: ["read this week", "for a future project", "keep for research", "losing it would feel wrong"],
    multi: false,
  },
  {
    key: "autonomy",
    kicker: "the autonomy dial",
    title: "How much librarian do you want?",
    why: "The librarian can suggest what to keep, or quietly clear the obvious noise. You remain in charge.",
    options: ["show me everything", "suggest, never act", "auto-triage the obvious", "curate the residue"],
    multi: false,
  },
];

const DRAFTS = ["CRT repair", "retro hardware", "local Salvador news", "spaceflight"];

const EMPTY_ANSWERS: Answers = {
  interests: [],
  research: [],
  missList: [],
  savedMeaning: "",
  autonomy: "suggest, never act",
};

function markdownList(values: string[], fallback: string): string {
  return values.length ? values.map((value) => `- ${value}`).join("\n") : `- ${fallback}`;
}

function buildNotebook(answers: Answers, acceptedDrafts: string[]): string {
  return `# librarian's notebook

## interests
${markdownList([...answers.interests, ...acceptedDrafts], "still learning")}

## future research
${markdownList(answers.research, "the hoard is open")}

## happily missed
${markdownList(answers.missList, "nothing named yet")}

## source priors
- Pragmatic Engineer: ingest by default
- kottke.org: skim titles, keep the strange ones
- TechCrunch: titles only
- A TARDE: keep Salvador local news

## rules (plain language)
- matching the miss-list -> dropped, with a visible receipt
- matching future research -> library, no reading debt
- borderline items -> keep in today's residue

## autonomy
- librarian mode: ${answers.autonomy || "suggest, never act"}
- saved means: ${answers.savedMeaning || "keep it safe"}

_updated by your triage actions · edit me directly_`;
}

function Wordmark() {
  return <span className="font-extrabold tracking-[-0.05em]">j<span className="text-amber-400">o</span>m<span className="text-amber-400">o</span></span>;
}

function Chip({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={cn("rounded-full px-3.5 py-2 text-sm transition-colors", active ? "bg-foreground font-medium text-background" : "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground")}>
      {children}
    </button>
  );
}

export function Onboarding({ onComplete, onSkip }: { onComplete: (profile: LibrarianProfile) => Promise<void>; onSkip: () => void }) {
  const [phase, setPhase] = useState<"welcome" | "interview" | "scan" | "review">("welcome");
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Answers>(EMPTY_ANSWERS);
  const [custom, setCustom] = useState("");
  const [acceptedDrafts, setAcceptedDrafts] = useState(DRAFTS);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const question = QUESTIONS[questionIndex];

  const selected = useMemo(() => {
    const answer = answers[question.key];
    return Array.isArray(answer) ? answer : answer ? [answer] : [];
  }, [answers, question.key]);

  const toggle = (value: string) => {
    if (question.multi) {
      const key = question.key as MultiAnswerKey;
      setAnswers((current) => ({ ...current, [key]: current[key].includes(value) ? current[key].filter((entry) => entry !== value) : [...current[key], value] }));
      return;
    }
    const key = question.key as SingleAnswerKey;
    setAnswers((current) => ({ ...current, [key]: value }));
  };

  const addCustom = () => {
    const value = custom.trim();
    if (!value) return;
    if (question.multi) {
      const key = question.key as MultiAnswerKey;
      setAnswers((current) => ({ ...current, [key]: current[key].includes(value) ? current[key] : [...current[key], value] }));
    } else {
      setAnswers((current) => ({ ...current, [question.key]: value }));
    }
    setCustom("");
  };

  const next = () => {
    if (questionIndex < QUESTIONS.length - 1) {
      setQuestionIndex((current) => current + 1);
      setCustom("");
    } else {
      setPhase("scan");
    }
  };

  const finish = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await onComplete({ answers, acceptedDrafts, notebook: buildNotebook(answers, acceptedDrafts), completedAt: Date.now() });
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "The librarian could not save this profile.");
    } finally {
      setSaving(false);
    }
  };

  if (phase === "welcome") {
    return (
      <main className="jomo-enter grid h-full min-h-0 place-items-center overflow-y-auto bg-background px-5 py-12">
        <section className="w-full max-w-2xl text-center">
          <h1 className="text-7xl sm:text-8xl"><Wordmark /></h1>
          <p className="mt-3 text-base text-muted-foreground">the joy of missing out</p>
          <p className="mx-auto mt-8 max-w-xl text-base leading-7 text-foreground/80">A quiet room that expects you to miss things. JOMO holds the firehose elsewhere, while a librarian learns what deserves your now.</p>
          <div className="mt-7 flex flex-wrap justify-center gap-x-5 gap-y-2 text-xs text-muted-foreground"><span>5 questions · 2 minutes</span><span>every one skippable</span><span>nothing sticks without your yes</span></div>
          <div className="mt-9 flex flex-wrap justify-center gap-2"><Button onClick={() => setPhase("interview")}>Begin</Button><Button variant="outline" onClick={onSkip}>Skip setup, I will do it later</Button></div>
        </section>
      </main>
    );
  }

  if (phase === "interview") {
    return (
      <main className="jomo-enter grid h-full min-h-0 place-items-center overflow-y-auto bg-background px-4 py-8">
        <section className="w-full max-w-xl">
          <div className="mb-6 flex justify-center gap-2" aria-label={`Question ${questionIndex + 1} of ${QUESTIONS.length}`}>{QUESTIONS.map((_, index) => <span key={index} className={cn("size-2 rounded-full", index === questionIndex ? "bg-primary" : index < questionIndex ? "bg-primary/40" : "bg-border")} />)}</div>
          <div className="rounded-3xl bg-card/60 p-6 shadow-sm ring-1 ring-border/50 sm:p-9">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-400">Question {questionIndex + 1} of 5 · {question.kicker}</p>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">{question.title}</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{question.why}</p>
            <div className="mt-6 flex flex-wrap gap-2">{question.options.map((option) => <Chip key={option} active={selected.includes(option)} onClick={() => toggle(option)}>{option}</Chip>)}</div>
            <form className="mt-6 flex gap-2 border-t border-border pt-5" onSubmit={(event) => { event.preventDefault(); addCustom(); }}><input value={custom} onChange={(event) => setCustom(event.target.value)} className="min-w-0 flex-1 bg-transparent text-sm max-md:pointer-coarse:!text-base outline-none placeholder:text-muted-foreground" placeholder="or type your own" /><Button type="submit" variant="outline" size="sm">Add</Button></form>
            <div className="mt-7 flex flex-wrap gap-2"><Button variant="outline" disabled={questionIndex === 0} onClick={() => setQuestionIndex((current) => Math.max(0, current - 1))}>Back</Button><Button onClick={next}>Next</Button><Button variant="ghost" onClick={next}>Skip this one</Button></div>
          </div>
        </section>
      </main>
    );
  }

  if (phase === "scan") {
    return (
      <main className="jomo-enter h-full min-h-0 overflow-y-auto bg-background px-5 py-10">
        <section className="mx-auto max-w-3xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">Material analysis · draft only</p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight">One last thing, let me look at what you already have.</h2>
          <p className="mt-2 text-sm text-muted-foreground">This prototype uses the configured sources and sample history. Nothing below becomes a rule until your confirmation.</p>
          <div className="mt-7 grid gap-2">
            {[['12 feeds + OPML export', 'read', 'text-emerald-400'], ['358 sample and past ingests', 'skimmed', 'text-emerald-400'], ['browser bookmarks', 'skipped', 'text-muted-foreground']].map(([label, status, color]) => <div key={label} className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm"><Icon name={status === 'skipped' ? 'Circle' : 'Check'} className="size-4" /><span>{label}</span><span className={cn("ml-auto text-xs", color)}>{status}</span></div>)}
          </div>
          <div className="mt-7 flex flex-wrap gap-2">{DRAFTS.map((draft) => <span key={draft} className="rounded-full border border-emerald-500/40 px-3 py-1.5 text-sm text-emerald-400">#{draft.replaceAll(' ', '-')} ✓</span>)}</div>
          <p className="mt-3 text-xs text-muted-foreground">Everything lands on the next screen for your yes or no.</p>
          <Button className="mt-7" onClick={() => setPhase("review")}>Review the draft</Button>
        </section>
      </main>
    );
  }

  return (
    <main className="jomo-enter h-full min-h-0 overflow-y-auto bg-background px-5 py-8">
      <section className="mx-auto max-w-3xl">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">Librarian draft</p>
        <h2 className="mt-3 text-2xl font-semibold tracking-tight">Here is what I think I know about you. Fix me.</h2>
        <ProfileSection title="From the interview">{[...answers.interests, ...answers.research, answers.savedMeaning, answers.autonomy].filter(Boolean).map((value) => <span key={value} className="rounded-full border border-border px-3 py-1.5 text-sm">{value}</span>)}</ProfileSection>
        <ProfileSection title="Drafted from your material, needs your yes">{DRAFTS.map((draft) => { const active = acceptedDrafts.includes(draft); return <button type="button" key={draft} onClick={() => setAcceptedDrafts((current) => active ? current.filter((entry) => entry !== draft) : [...current, draft])} className={cn("rounded-full border px-3 py-1.5 text-sm", active ? "border-emerald-500/50 text-emerald-400" : "border-border text-muted-foreground line-through")}>{active ? '✓' : '×'} {draft}</button>; })}</ProfileSection>
        <ProfileSection title="Happily missed">{answers.missList.length ? answers.missList.map((value) => <span key={value} className="rounded-full border border-border px-3 py-1.5 text-sm text-muted-foreground line-through">{value}</span>) : <span className="text-sm text-muted-foreground">Nothing named yet.</span>}</ProfileSection>
        <div className="mt-8 rounded-2xl border border-border bg-card p-5"><p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Source priors</p><div className="mt-4 grid gap-2 text-sm"><p>Pragmatic Engineer <span className="float-right text-muted-foreground">ingest by default</span></p><p>kottke.org <span className="float-right text-muted-foreground">skim titles, keep the strange ones</span></p><p>TechCrunch <span className="float-right text-muted-foreground">titles only</span></p><p>A TARDE <span className="float-right text-muted-foreground">keep Salvador local news</span></p></div></div>
        {saveError && <p role="alert" className="mt-6 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">Could not save the notebook: {saveError}</p>}
        <div className="mt-8 flex flex-wrap gap-2"><Button disabled={saving} onClick={() => void finish()}>{saving ? 'Saving…' : 'Looks right, start hoarding'}</Button><Button variant="outline" onClick={() => { setPhase("interview"); setQuestionIndex(0); }}>Ask again</Button><Button variant="ghost" onClick={onSkip}>Decide later</Button></div>
      </section>
    </main>
  );
}

function ProfileSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="mt-7"><h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{title}</h3><div className="flex flex-wrap gap-2">{children}</div></section>;
}

export function NotebookPanel({ profile, open, onClose, onSave, onReinterview }: { profile: LibrarianProfile; open: boolean; onClose: () => void; onSave: (notebook: string) => Promise<void>; onReinterview: () => void }) {
  const [draft, setDraft] = useState(profile.notebook);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    if (open) setDraft(profile.notebook);
  }, [open, profile.notebook]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-background/70 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Librarian's notebook" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="jomo-enter flex h-full w-full max-w-2xl flex-col border-l border-border bg-background shadow-2xl">
        <header className="flex items-start gap-3 border-b border-border p-5 pt-[max(1.25rem,env(safe-area-inset-top))] max-sm:pointer-coarse:pl-16 max-sm:pointer-coarse:pb-4"><div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-400">Yours to edit</p><h2 className="mt-1 text-xl font-semibold">Librarian's notebook</h2><p className="mt-1 text-xs text-muted-foreground">Stored by JOMO, readable as plain markdown.</p></div><button type="button" className="ml-auto rounded-md p-2 hover:bg-muted" onClick={onClose} aria-label="Close notebook"><Icon name="X" className="size-4" /></button></header>
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} className="min-h-0 flex-1 resize-none bg-card/40 p-5 font-mono text-sm max-md:pointer-coarse:!text-base leading-7 outline-none" spellCheck={false} />
        <footer className="flex flex-wrap items-center gap-2 border-t border-border p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"><Button disabled={saving} onClick={() => { setSaving(true); setStatus(null); void onSave(draft).then(() => setStatus("Notebook saved.")).catch((cause: unknown) => setStatus(cause instanceof Error ? cause.message : "Save failed.")).finally(() => setSaving(false)); }}>{saving ? 'Saving…' : 'Save notebook'}</Button><Button variant="outline" onClick={onReinterview}>The librarian lost the plot</Button>{status && <span role="status" className="text-xs text-muted-foreground">{status}</span>}<span className="ml-auto text-xs text-muted-foreground">Nothing acts without a visible rule.</span></footer>
      </aside>
    </div>
  );
}

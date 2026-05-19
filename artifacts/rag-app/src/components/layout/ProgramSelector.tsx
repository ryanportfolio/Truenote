interface ProgramSelectorProps {
  currentProgramId: string;
}

const STUB_PROGRAMS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "00000000-0000-0000-0000-0000000000aa", name: "Demo Program" }
];

export function ProgramSelector({ currentProgramId }: ProgramSelectorProps): JSX.Element {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">Program</span>
      <select
        value={currentProgramId}
        onChange={() => {
          /* TODO Phase 2: wire program switching to session/cookie */
        }}
        className="rounded border border-input bg-background px-2 py-1 text-xs"
      >
        {STUB_PROGRAMS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}

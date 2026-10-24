"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { Loader2, MessageSquare, Paperclip, Plus, Search } from "lucide-react";
import { Popover } from "radix-ui";
import { cn } from "cn";

/*
 * The composer's plus button: one control, inside the textarea's own frame,
 * that opens the small menu of things a message can carry. ChatGPT-shaped:
 * the button sits in the input area's bottom-left, a round hover target the
 * same size as the send button, quiet until hovered.
 *
 * Two kinds of offer:
 *  - actions: caller-supplied, executed on click (attach a file);
 *  - record references: a searchable lookup over the workspace's notes,
 *    zettels, artifacts and conversations. Picking one calls onReference
 *    with a markdown link the caller inserts into the draft, because the
 *    message text is what the model actually reads.
 *
 * A caller with nothing to offer passes no items and no onReference, and the
 * button does not render — a plus that opens an empty menu is chrome lying
 * about capability.
 */

export type ComposerPlusItem = {
  label: string;
  hint?: string;
  icon: ReactNode;
  onSelect: () => void;
};

export type RecordReference = {
  id: string;
  kind: "note" | "zettel" | "artifact" | "conversation";
  title: string;
  href: string;
};

const KIND_LABELS: Record<RecordReference["kind"], string> = {
  note: "Note",
  zettel: "Zettel",
  artifact: "Artifact",
  conversation: "Conversation",
};

function referenceLink(record: RecordReference): string {
  return `[${KIND_LABELS[record.kind]}: ${record.title}](${record.href})`;
}

export function ComposerPlus({
  items = [],
  records,
  onReference,
  onQueryChange,
  onOpenChange,
  onFile,
  label = "Add to message",
  disabled = false,
  className,
}: {
  items?: ComposerPlusItem[];
  /** Live lookup results; undefined while idle, null while loading. */
  records?: RecordReference[] | null;
  /** Receives a markdown link for the picked record, to insert into the draft. */
  onReference?: (markdown: string, record: RecordReference) => void;
  /** Fires when the menu opens (empty query) or the search text changes. */
  onQueryChange?: (query: string) => void;
  /** Fires when the menu opens or closes; lets the caller gate the search fetch. */
  onOpenChange?: (open: boolean) => void;
  /** Receives the picked file; renders the hidden input itself when set. */
  onFile?: (file: File) => void;
  /** Accessible name; the home composer and reply composer frame it differently. */
  label?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [lastKey, setLastKey] = useState("");

  const grouped: Array<{ kind: RecordReference["kind"]; rows: RecordReference[] }> = [];
  for (const record of records ?? []) {
    let group = grouped.find((g) => g.kind === record.kind);
    if (!group) {
      group = { kind: record.kind, rows: [] };
      grouped.push(group);
    }
    group.rows.push(record);
  }
  const flat = grouped.flatMap((g) => g.rows);

  // Reset the highlight when the result set changes, during render (the
  // React-recommended alternative to an effect setState).
  const key = records === undefined ? "" : String(flat.length);
  if (key !== lastKey) {
    setLastKey(key);
    setActive(0);
  }

  function changeOpen(next: boolean) {
    setOpen(next);
    if (next) {
      // Fresh menu, fresh search. The focus lands here too: Radix's
      // onOpenAutoFocus would fight the popover's own focus return, so the
      // open transition owns both.
      setQuery("");
      onQueryChange?.("");
      requestAnimationFrame(() => searchRef.current?.focus());
    }
    onOpenChange?.(next);
  }

  function changeQuery(next: string) {
    setQuery(next);
    onQueryChange?.(next);
  }

  function commit(record: RecordReference) {
    changeOpen(false);
    onReference?.(referenceLink(record), record);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, flat.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter" && flat[active]) {
      event.preventDefault();
      commit(flat[active]);
    }
  }

  // The ref read lives in this click handler, so the rule can see it never
  // runs during render.
  function pickFile() {
    fileInputRef.current?.click();
  }
  function fileChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) onFile?.(file);
    event.target.value = "";
  }

  // A plus that opens an empty menu is chrome lying about capability. Checked
  // after the hooks, which must run unconditionally.
  if (items.length === 0 && !onReference && !onFile) return null;

  return (
    <Popover.Root open={open} onOpenChange={changeOpen}>
      <Popover.Trigger
        type="button"
        disabled={disabled}
        aria-label={label}
        title={label}
        className={cn(
          "text-muted-foreground hover:bg-muted hover:text-foreground flex size-8 shrink-0 items-center justify-center rounded-full outline-none transition-colors",
          "focus-visible:ring-ring focus-visible:ring-3",
          "data-[state=open]:bg-muted data-[state=open]:text-foreground",
          disabled && "pointer-events-none opacity-40",
          className,
        )}
      >
        <Plus aria-hidden className="size-4" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          side="top"
          sideOffset={8}
          onKeyDown={onKeyDown}
          className="bg-popover text-popover-foreground border-border z-50 w-80 max-w-[calc(100vw-2rem)] rounded-xl border p-1 shadow-md"
        >
          {onReference ? (
            <div className="flex items-center gap-2 border-border border-b px-2.5 pb-1.5">
              <Search aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => changeQuery(event.target.value)}
                placeholder="Search notes, artifacts, conversations…"
                aria-label="Search records to attach"
                aria-controls={listId}
                className="placeholder:text-muted-foreground h-8 w-full bg-transparent text-[13px] outline-none"
              />
            </div>
          ) : null}

          {records === null ? (
            <p role="status" className="text-muted-foreground flex items-center gap-2 px-2.5 py-3 text-[12px]">
              <Loader2 aria-hidden className="size-3.5 animate-spin" /> Searching…
            </p>
          ) : null}

          {records !== null && onReference && flat.length === 0 ? (
            <p className="text-muted-foreground px-2.5 py-3 text-[12px]">
              {query.trim() ? "Nothing matches. Try a different word." : "No records yet."}
            </p>
          ) : null}

          {flat.length > 0 ? (
            <ul ref={listRef} id={listId} role="listbox" aria-label="Records" className="max-h-64 overflow-y-auto py-0.5">
              {grouped.map((group) => (
                <li key={group.kind} role="presentation">
                  <p className="text-muted-foreground px-2.5 pt-1.5 pb-0.5 text-[10px] font-medium tracking-wide uppercase">
                    {KIND_LABELS[group.kind]}s
                  </p>
                  <ul role="presentation">
                    {group.rows.map((record) => {
                      const index = flat.indexOf(record);
                      return (
                        <li key={record.id} role="presentation">
                          <button
                            type="button"
                            role="option"
                            aria-selected={index === active}
                            onMouseEnter={() => setActive(index)}
                            onClick={() => commit(record)}
                            className={cn(
                              "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] outline-none",
                              index === active ? "bg-muted" : "hover:bg-muted/60",
                            )}
                          >
                            {record.kind === "conversation" ? (
                              <MessageSquare aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
                            ) : (
                              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current opacity-40" />
                            )}
                            <span className="min-w-0 flex-1 truncate">{record.title}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          ) : null}

          {items.length > 0 ? (
            <div className="border-border border-t pt-1 pb-0.5">
              {items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                  className="hover:bg-muted focus-visible:bg-muted flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] outline-none"
                >
                  <span className="text-muted-foreground shrink-0 [&_svg]:size-4">{item.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{item.label}</span>
                    {item.hint ? (
                      <span className="text-muted-foreground block truncate text-[11px]">{item.hint}</span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {onFile ? (
            <div className={cn("border-border pt-1 pb-0.5", items.length > 0 && "border-t")}>
              <button
                type="button"
                onClick={() => {
                  // The menu closes BEFORE the picker opens: the hidden input
                  // lives outside this portal (below), so it stays mounted and
                  // its change event always fires.
                  setOpen(false);
                  onOpenChange?.(false);
                  pickFile();
                }}
                className="hover:bg-muted focus-visible:bg-muted flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] outline-none"
              >
                <Paperclip aria-hidden className="text-muted-foreground size-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">Attach a file</span>
                  <span className="text-muted-foreground block truncate text-[11px]">
                    Captured to your inbox, up to 4 MB
                  </span>
                </span>
              </button>
            </div>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
      {/*
       * The file input lives OUTSIDE the popover portal: an input mounted
       * inside Popover.Content unmounts when the menu closes, and the file
       * chooser's change event then fires on a dead node — the picked file
       * never reaches onFile. Mounted here, it survives the close.
       */}
      {onFile ? (
        <input
          ref={fileInputRef}
          id={fileInputId}
          type="file"
          className="hidden"
          aria-hidden
          tabIndex={-1}
          onChange={fileChosen}
        />
      ) : null}
    </Popover.Root>
  );
}

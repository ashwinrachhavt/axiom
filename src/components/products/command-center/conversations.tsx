"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Empty, Field, Panel, Screen, Status, Unavailable } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { Destination, DisabledAction, Select } from "./controls";

export default function Conversations() {
  const { state, addArtifact, updateArtifact, notify } = useWorkspace();
  const [objective, setObjective] = useState("");
  const [title, setTitle] = useState("");
  const [contextId, setContextId] = useState("");
  const drafts = state.artifacts.filter((artifact) => artifact.tags.includes("Conversation preparation"));
  return <Screen title="Conversations" description="Local preparation notes are not durable message threads." actions={<Destination screen="reviews">Inspect external action reviews</Destination>}><Unavailable feature="Message threads and checkpoints">The thread service and agent runtime are unavailable. Sending, streaming responses, questions, cancellation and execution checkpoints require configured domain adapters.</Unavailable><Panel title="Prepare a conversation"><form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); const record = addArtifact(title.trim() || "Conversation preparation", "note", objective); if (record) { updateArtifact(record.id, { tags: ["Conversation preparation", "Not sent"], links: contextId ? [contextId] : [] }); setObjective(""); setTitle(""); notify("Objective saved as a canonical note. No message or run was created."); } }}><Field label="Preparation title"><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300}/></Field><Field label="Context record"><Select value={contextId} onChange={(e) => setContextId(e.target.value)}><option value="">No context selected</option>{[...state.tasks, ...state.opportunities, ...state.artifacts].map((record) => <option key={record.id} value={record.id}>{record.title}</option>)}</Select></Field><Field label="Bounded objective"><Textarea value={objective} onChange={(e) => setObjective(e.target.value)} maxLength={20000} required placeholder="What should the assistant prepare, from which evidence, with what stopping condition?"/></Field><div className="flex flex-wrap gap-2">{["Research this organization from approved public sources", "Prepare a follow-up draft without sending", "Compare the linked requirements and résumé"].map((prompt) => <Button key={prompt} type="button" size="sm" variant="outline" onClick={() => setObjective(prompt)}>{prompt}</Button>)}</div><Button type="submit" disabled={!objective.trim()}>Save preparation note</Button><DisabledAction reason="No configured model or durable thread service. Saving preparation does not send it.">Send to the assistant</DisabledAction></form></Panel><Panel title="Local preparation notes">{drafts.map((draft) => <div key={draft.id} className="border-b border-border py-3 text-[13px]"><div className="flex flex-wrap justify-between gap-2"><p>{draft.title}</p><Status>Not sent / v{draft.version}</Status></div><p className="mt-2 whitespace-pre-wrap">{draft.body}</p></div>)}{!drafts.length && <Empty title="No conversation preparation" description="No objectives yet."/>}<div className="mt-4"><Destination screen="writing">Edit canonical notes</Destination></div></Panel></Screen>;
}

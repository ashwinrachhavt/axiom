import { Activity, BookOpen, Brain, BriefcaseBusiness, CalendarDays, ChartNoAxesCombined, CircleDot, ClipboardList, FileCheck2, FileText, FolderKanban, Gem, Grid2X2, Inbox, Layers3, Library, Lightbulb, Link2, ListTodo, Map, MessageSquare, Network, NotebookPen, PanelTop, PenLine, ScanText, Search, Settings, ShieldCheck, Timer, Users, Wallet, Workflow, type LucideIcon } from "lucide-react";

export type ProductId = "command-center" | "neuralflow" | "alfred";
export type ProductDestination = { slug: string; label: string; icon: LucideIcon; group: string; description: string };
export type Product = { id: ProductId; name: string; description: string; icon: LucideIcon; home: string; destinations: ProductDestination[] };
export const products: Product[] = [
  { id: "command-center", name: "Command Center", description: "Relationships, decisions and operations", icon: PanelTop, home: "briefing", destinations: [
    { slug: "briefing", label: "Briefing", icon: CircleDot, group: "Today", description: "A deterministic daily decision surface" },
    { slug: "inbox", label: "Inbox", icon: Inbox, group: "Today", description: "Clarify captured material" },
    { slug: "work", label: "Work queue", icon: ClipboardList, group: "Today", description: "Canonical tasks and waiting commitments" },
    { slug: "contacts", label: "Contacts", icon: Users, group: "Relationships", description: "People, evidence and follow-ups" },
    { slug: "companies", label: "Companies", icon: BriefcaseBusiness, group: "Relationships", description: "Organizations and context" },
    { slug: "opportunities", label: "Opportunities", icon: FolderKanban, group: "Relationships", description: "Track roles and leads" },
    { slug: "applications", label: "Applications", icon: FileCheck2, group: "Relationships", description: "Prepare reviewed application materials" },
    { slug: "documents", label: "Document vault", icon: ScanText, group: "Workspace", description: "Intake, classify and preserve originals" },
    { slug: "writing", label: "Writing studio", icon: PenLine, group: "Workspace", description: "Draft and checkpoint canonical notes" },
    { slug: "spaces", label: "Spaces", icon: Layers3, group: "Workspace", description: "Operational context and project outcomes" },
    { slug: "memory", label: "Reviewed memory", icon: Brain, group: "Supervision", description: "Review personal fact assertions" },
    { slug: "reviews", label: "Reviews", icon: ShieldCheck, group: "Supervision", description: "Inspect exact payloads before external writes" },
    { slug: "spending", label: "Spending", icon: Wallet, group: "System", description: "Reservations, rate cards and caps" },
    { slug: "companion", label: "Browser companion", icon: Workflow, group: "System", description: "Explicit reader and autofill pairing" },
    { slug: "integrations", label: "Connections", icon: Link2, group: "System", description: "Account aliases and sync health" },
    { slug: "activity", label: "Activity", icon: Activity, group: "System", description: "What changed and why" },
    { slug: "settings", label: "Settings", icon: Settings, group: "System", description: "Preferences, policies and safety" },
  ] },
  { id: "neuralflow", name: "NeuralFlow", description: "Capture, plan and protect your focus", icon: Grid2X2, home: "dashboard", destinations: [
    { slug: "dashboard", label: "Overview", icon: CircleDot, group: "Execute", description: "The day at a glance" },
    { slug: "tasks", label: "Tasks", icon: ListTodo, group: "Execute", description: "One task model, many views" },
    { slug: "boards", label: "Boards", icon: FolderKanban, group: "Execute", description: "Saved Kanban views over tasks" },
    { slug: "calendar", label: "Calendar", icon: CalendarDays, group: "Execute", description: "Work blocks and provider events" },
    { slug: "scheduler", label: "Scheduler", icon: Workflow, group: "Execute", description: "Review time-block suggestions" },
    { slug: "focus", label: "Focus", icon: Timer, group: "Focus & reflect", description: "One task, one durable local session" },
    { slug: "brain-dump", label: "Brain dump", icon: Lightbulb, group: "Focus & reflect", description: "Capture a plan for deliberate acceptance" },
    { slug: "reports", label: "Reports", icon: ChartNoAxesCombined, group: "Focus & reflect", description: "Work and focus reflection" },
    { slug: "rewards", label: "Stone collection", icon: Gem, group: "Focus & reflect", description: "Idempotent focus rewards" },
    { slug: "projects", label: "Projects", icon: Layers3, group: "Workspace", description: "Outcomes and their linked tasks" },
    { slug: "notes", label: "Notes", icon: NotebookPen, group: "Workspace", description: "Canonical notes shared across the workspace" },
    { slug: "meetings", label: "Meetings", icon: Users, group: "Workspace", description: "Events, notes and action items" },
  ] },
  { id: "alfred", name: "Alfred", description: "Read, connect and build understanding", icon: BookOpen, home: "dashboard", destinations: [
    { slug: "dashboard", label: "Knowledge home", icon: CircleDot, group: "Knowledge", description: "Your connected thinking workspace" },
    { slug: "files", label: "Files", icon: FolderKanban, group: "Knowledge", description: "Browse, search and review every document" },
    { slug: "library", label: "Source library", icon: Library, group: "Knowledge", description: "Source reader, intake and evidence" },
    { slug: "zettels", label: "Atomic zettels", icon: Layers3, group: "Knowledge", description: "One sourced idea per knowledge card" },
    { slug: "dossiers", label: "Dossiers", icon: FolderKanban, group: "Knowledge", description: "Bounded source-grounded workspaces" },
    { slug: "notebook", label: "Notebook", icon: NotebookPen, group: "Knowledge", description: "Rich notes, checkpoints and backlinks" },
    { slug: "graph", label: "Knowledge graph", icon: Network, group: "Knowledge", description: "Links across canonical artifacts" },
    { slug: "studio", label: "Studio", icon: PenLine, group: "Create & research", description: "Grounded artifacts from pinned sources" },
    { slug: "research", label: "Deep research", icon: Search, group: "Create & research", description: "Bounded questions and citation budgets" },
    { slug: "chat", label: "Ask Polymath", icon: MessageSquare, group: "Create & research", description: "Supervised grounded conversation" },
    { slug: "blogs", label: "Blog studio", icon: FileText, group: "Create & research", description: "Draft before reviewed publishing" },
    { slug: "dictionary", label: "Dictionary", icon: BookOpen, group: "Learn", description: "Concepts, senses and annotations" },
    { slug: "canvas", label: "Canvas", icon: Map, group: "Learn", description: "System-design whiteboards linked to notes" },
    { slug: "projects", label: "Projects", icon: BriefcaseBusiness, group: "Workspace", description: "Shared outcomes and knowledge" },
    { slug: "integrations", label: "Connectors", icon: Link2, group: "Workspace", description: "Source ingestion providers" },
  ] },
];
export function productHref(product: Product, slug = product.home) { return `/apps/${product.id}/${slug}`; }


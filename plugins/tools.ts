// OpenKan — custom OpenCode tools.
// Loaded by OpenCode as a second plugin file (sibling of plugins/kanban.ts).
//
// Exposes the following tools to the agent:
//   - kanban_add
//   - kanban_move
//   - kanban_start
//   - kanban_view
//   - kanban_import
//   - kanban_ask          (M7 — ask the user a structured question)
//   - kanban_respond      (M7 — read the user's response after kanban_ask)
//   - kanban_comments     (M8 — read comments with block-context excerpts)
//   - kanban_preview      (M9 — dry-run TSX before embedding <Preview>)
//
// Each tool mutates the shared board (via withWrite / getBoard) and broadcasts
// events over the local SSE server (via getServer) so the UI updates live.

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { withWrite, newId, getBoard, getProjectRoot, KANBAN_DIR, nowIso, type Task } from "../kanban/board.ts"
import { getServer } from "../kanban/server.ts"
import { writeTaskMdx } from "../kanban/mdx.ts"
import { scanFiles, parseCheckboxes, stableImportId, slugFromRaw, type CheckboxHit } from "../kanban/import.ts"
import { addInput, listInputs } from "../kanban/inputs.ts"
import { listComments } from "../kanban/comments.ts"
import { compileTsx } from "../kanban/tsx-sandbox.ts"
import { extractMetadata, type Priority, type Effort, type Category } from "../kanban/tags.ts"
import { recordEvent, readEvents, readSummary, type ChangelogKind } from "../kanban/changelog.ts"
import { listContributors, attributeCommitsToTasks, isGitRepo } from "../kanban/git.ts"
import { existsSync, readFileSync, statSync } from "fs"
import { join, relative } from "path"

const COLUMNS = ["backlog", "todo", "doing", "review", "done"] as const
type ColumnId = (typeof COLUMNS)[number]

// Local type extension for tasks that carry the new metadata fields
// (tags, category, priority, effort). The canonical Task type in board.ts
// is owned by the backend track; this keeps the tool file decoupled from
// that work and produces an explicit conflict point when the two align.
type TaskWithMeta = Task & {
  tags?: string[]
  category?: Category | null
  priority?: Priority | null
  effort?: Effort | null
}

interface ImportConfig {
  include?: string[]
  exclude?: string[]
}

function readImportConfig(root: string, configPath?: string): ImportConfig {
  const cfgFile = configPath ?? join(root, ".openkan", "config.json")
  if (!existsSync(cfgFile)) return {}
  // existsSync returns true for directories; readFileSync would throw EISDIR.
  try {
    if (!statSync(cfgFile).isFile()) return {}
  } catch {
    return {}
  }
  try {
    return JSON.parse(readFileSync(cfgFile, "utf8")) as ImportConfig
  } catch {
    return {}
  }
}

function asColumn(v: unknown, fallback: ColumnId = "todo"): ColumnId {
  return (COLUMNS as readonly string[]).includes(v as string)
    ? (v as ColumnId)
    : fallback
}

export const OpenKanToolsPlugin: Plugin = async (ctx) => {
  const broadcast = (event: string, data: unknown) => {
    getServer()?.broadcast(event, data)
  }

  return {
    tool: {
      kanban_add: tool({
        description: "Add a new task to the kanban board.",
        args: {
          title: tool.schema.string().describe("Short task title"),
          description: tool.schema
            .string()
            .optional()
            .describe("Detailed description / prompt for the agent"),
          column: tool.schema
            .enum(["backlog", "todo", "doing", "review", "done"])
            .optional()
            .describe("Column id (default: todo)"),
          agent: tool.schema
            .string()
            .optional()
            .describe("OpenCode agent name (default: project default)"),
          tags: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Explicit tag names. Merged with tags derived from title/description; explicit tags win on conflict."),
          priority: tool.schema
            .enum(["low", "normal", "high", "urgent"])
            .optional()
            .describe("Explicit priority (overrides derived)"),
          category: tool.schema
            .enum(["frontend", "backend", "infra", "docs", "test", "design", "data", "security", "task"])
            .optional()
            .describe("Explicit category (overrides derived)"),
          effort: tool.schema
            .enum(["xs", "s", "m", "l", "xl"])
            .optional()
            .describe("Explicit effort size (overrides derived)"),
        },
        async execute(args) {
          const now = new Date().toISOString()
          const column = asColumn(args.column, "todo")
          // Derive metadata once before we have a task — the task is created
          // with these fields, and the caller's explicit overrides win.
          const derived = extractMetadata({ title: args.title, description: args.description ?? "" })
          const explicit = (args.tags ?? []).map((t) => String(t).toLowerCase().trim()).filter(Boolean)
          const seen = new Set<string>()
          const mergedTags: string[] = []
          for (const t of derived.tags) {
            const k = t.toLowerCase()
            if (!seen.has(k)) { seen.add(k); mergedTags.push(k) }
          }
          for (const t of explicit) {
            if (!seen.has(t)) { seen.add(t); mergedTags.push(t) }
          }
          const task: TaskWithMeta = {
            id: newId("tsk"),
            title: args.title,
            description: args.description ?? "",
            column,
            order: 0,
            sessionId: null,
            agent: args.agent ?? "",
            model: null,
            status: "idle",
            lastError: null,
            createdAt: now,
            updatedAt: now,
            artifact: "",
            sessionArtifact: null,
            tags: mergedTags,
            category: (args.category ?? derived.category) as Category,
            priority: (args.priority ?? derived.priority) as Priority,
            effort: (args.effort ?? derived.effort) as Effort | null,
            archived: false,
          }

          await withWrite(async (board) => {
            const col = board.columns.find((c) => c.id === column) ?? board.columns[1]
            task.column = col.id
            const inCol = board.tasks.filter((t) => t.column === task.column)
            task.order = inCol.length
            task.artifact = `.openkan/tasks/${task.id}.mdx`
            board.tasks.push(task as unknown as Task)
          })

          const fresh = (await getBoard()).tasks.find((t) => t.id === task.id)
          broadcast("task.created", { task: fresh ?? task })
          return `Added task ${task.id}: ${task.title}` +
            (task.tags && task.tags.length ? ` [tags: ${task.tags.join(", ")}]` : "")
        },
      }),

      kanban_move: tool({
        description: "Move a task to a different column and/or reorder it.",
        args: {
          taskId: tool.schema.string().describe("Task id, e.g. 'tsk-abc12345'"),
          column: tool.schema
            .enum(["backlog", "todo", "doing", "review", "done"])
            .describe("Target column id"),
          order: tool.schema
            .number()
            .optional()
            .describe("New order index inside the target column; renormalized"),
        },
        async execute(args) {
          const column = asColumn(args.column, "todo")
          let updated: Task | undefined
          await withWrite(async (board) => {
            const t = board.tasks.find((x) => x.id === args.taskId)
            if (!t) throw new Error(`Task ${args.taskId} not found`)
            t.column = column
            t.updatedAt = new Date().toISOString()
            if (typeof args.order === "number") t.order = args.order
            // Renormalize order inside the destination column.
            const col = board.tasks
              .filter((x) => x.column === column)
              .sort((a, b) => a.order - b.order)
            col.forEach((tt, i) => (tt.order = i))
            updated = t
          })
          const fresh = (await getBoard()).tasks.find((t) => t.id === args.taskId)
          broadcast("task.updated", { task: fresh ?? updated })
          return `Moved task ${args.taskId} to ${column}`
        },
      }),

      kanban_start: tool({
        description:
          "Start the OpenCode agent on a task. Creates a session and sends the task description as the initial prompt.",
        args: {
          taskId: tool.schema.string().describe("Task id"),
          agent: tool.schema
            .string()
            .optional()
            .describe("Agent name override; defaults to task.agent then project default"),
          model: tool.schema
            .string()
            .optional()
            .describe("Model override in 'providerID/modelID' form"),
        },
        async execute(args) {
          const board = await getBoard()
          const task = board.tasks.find((t) => t.id === args.taskId)
          if (!task) throw new Error(`Task ${args.taskId} not found`)
          if (task.sessionId && task.status === "running") {
            throw new Error("Task already running")
          }

          // Resolve + validate agent.
          let agentName = args.agent ?? task.agent
          const agentsResp = await ctx.client.app.agents()
          const agents = (agentsResp.data ?? []) as Array<{
            name: string
            mode: string
          }>
          if (!agentName) {
            const primary = agents.find((a) => a.mode === "primary") ?? agents[0]
            agentName = primary?.name ?? "build"
          } else if (!agents.some((a) => a.name === agentName)) {
            throw new Error(
              `Unknown agent '${agentName}'. Available: ${agents.map((a) => a.name).join(", ")}`,
            )
          }

          // Create a session and link it to the task before prompting.
          const sess = await ctx.client.session.create({
            body: { title: `[${task.id}] ${task.title}` },
          })
          const sessionId = sess.data!.id

          await withWrite(async (b) => {
            b.sessions[sessionId] = {
              taskId: task.id,
              status: "running",
              startedAt: new Date().toISOString(),
              endedAt: null,
            }
            const t = b.tasks.find((x) => x.id === task.id)!
            t.sessionId = sessionId
            t.agent = agentName!
            t.status = "running"
            t.updatedAt = new Date().toISOString()
            if (args.model) t.model = args.model
          })

          const parts: Array<{ type: "text"; text: string }> = [
            { type: "text", text: `# ${task.title}\n\n${task.description}` },
          ]
          const body: {
            parts: typeof parts
            model?: { providerID: string; modelID: string }
            agent?: string
          } = { parts }
          if (args.model) {
            const [providerID, ...rest] = args.model.split("/")
            body.model = { providerID, modelID: rest.join("/") }
          }
          if (agentName) body.agent = agentName

          await ctx.client.session.promptAsync({
            path: { id: sessionId },
            body,
          })

          const fresh = (await getBoard()).tasks.find((t) => t.id === task.id)
          broadcast("task.updated", { task: fresh })
          return `Started session ${sessionId} for task ${task.id} with agent '${agentName}'`
        },
      }),

      kanban_view: tool({
        description:
          "Read-only: list tasks on the board, optionally filtered by column, status, category, and/or tags. Output includes each task's tags, category, priority, and effort when available.",
        args: {
          column: tool.schema
            .enum(["backlog", "todo", "doing", "review", "done"])
            .optional()
            .describe("Filter by column"),
          status: tool.schema
            .enum(["idle", "running", "done", "failed", "cancelled"])
            .optional()
            .describe("Filter by status"),
          category: tool.schema
            .enum(["frontend", "backend", "infra", "docs", "test", "design", "data", "security", "task"])
            .optional()
            .describe("Filter by category (matches the task's category field or its tag list)"),
          tags: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Filter to tasks whose tag list contains ALL of these tags (AND-of-tags)"),
        },
        async execute(args) {
          const board = await getBoard()
          let tasks = board.tasks
          if (args.column) tasks = tasks.filter((t) => t.column === args.column)
          if (args.status) tasks = tasks.filter((t) => t.status === args.status)
          if (args.category) {
            const want = args.category
            tasks = tasks.filter((t) => {
              if ((t as TaskWithMeta).category === want) return true
              const tags = (t as TaskWithMeta).tags ?? []
              return tags.includes(want)
            })
          }
          if (args.tags && args.tags.length > 0) {
            const wanted = args.tags.map((x) => String(x).toLowerCase())
            tasks = tasks.filter((t) => {
              const set = new Set(((t as TaskWithMeta).tags ?? []).map((x) => String(x).toLowerCase()))
              return wanted.every((w) => set.has(w))
            })
          }
          tasks = [...tasks].sort((a, b) => {
            const ca = board.columns.findIndex((c) => c.id === a.column)
            const cb = board.columns.findIndex((c) => c.id === b.column)
            if (ca !== cb) return ca - cb
            return a.order - b.order
          })
          if (tasks.length === 0) return "No tasks match."
          return tasks
            .map((t) => {
              const meta = t as TaskWithMeta
              const parts: string[] = []
              parts.push(`column=${t.column}`)
              parts.push(`status=${t.status}`)
              parts.push(`agent=${t.agent || "(default)"}`)
              if (meta.category) parts.push(`category=${meta.category}`)
              if (meta.priority) parts.push(`priority=${meta.priority}`)
              if (meta.effort) parts.push(`effort=${meta.effort}`)
              if (meta.tags && meta.tags.length) parts.push(`tags=${meta.tags.join(",")}`)
              return `[${t.id}] ${t.title} — ${parts.join(" ")}`
            })
            .join("\n")
        },
      }),

      kanban_import: tool({
        description: "Scan the project for '- [ ]' checkboxes in .md/.mdx files and create one Backlog task per hit. Idempotent on unchanged content (M4 will add full source-line tracking).",
        args: {
          include: tool.schema.array(tool.schema.string()).optional()
            .describe("Glob patterns to include (default: docs/**, *.md, *.mdx)"),
          exclude: tool.schema.array(tool.schema.string()).optional()
            .describe("Glob patterns to exclude"),
          configPath: tool.schema.string().optional()
            .describe("Path to .openkan/config.json; defaults to .openkan/config.json at project root"),
        },
        async execute(args) {
          const root = getProjectRoot()

          const include = args.include ?? []
          const exclude = args.exclude ?? []
          const cfg = readImportConfig(root, args.configPath)
          const finalInclude = include.length ? include : (cfg.include ?? [])
          const finalExclude = exclude.length ? exclude : (cfg.exclude ?? [])

          const { files, scanned, skipped } = scanFiles({ root, include: finalInclude, exclude: finalExclude })
          const hits: CheckboxHit[] = []
          for (const f of files) {
            let content: string
            try { content = readFileSync(f, "utf8") } catch { continue }
            hits.push(...parseCheckboxes(content, relative(root, f)))
          }

          const created: Task[] = []
          const skippedExisting: string[] = []
          await withWrite(async (board) => {
            // Dedup by exact path:line:raw so two different checkboxes that happen
            // to slug-collide (e.g. "Foo Bar" and "Foo--Bar") stay distinct.
            const seen = new Set<string>()
            for (const t of board.tasks) {
              if (t.source) seen.add(`${t.source.path}:${t.source.line}:${t.source.slug}`)
            }
            let orderOffset = board.tasks.filter(t => t.column === "backlog").length
            for (const h of hits) {
              const slug = slugFromRaw(h.raw)
              // Key uses raw text so distinct checkboxes aren't merged by slug normalisation.
              const key = `${h.path}:${h.line}:${h.raw}`
              if (seen.has(key)) {
                skippedExisting.push(key)
                continue
              }
              seen.add(key)
              const id = stableImportId(h)
              // Derive tags/category/priority/effort from the checkbox text.
              // The checkbox body is the title; the description is empty.
              const derived = extractMetadata({ title: h.raw, description: "" })
              const task: TaskWithMeta = {
                id,
                title: h.raw || "(empty checkbox)",
                description: "",
                column: "backlog",
                order: orderOffset++,
                sessionId: null,
                agent: "",
                model: null,
                status: "idle",
                lastError: null,
                createdAt: nowIso(),
                updatedAt: nowIso(),
                artifact: `.openkan/tasks/${id}.mdx`,
                sessionArtifact: null,
                source: { path: h.path, line: h.line, slug },
                tags: derived.tags,
                category: derived.category,
                priority: derived.priority,
                effort: derived.effort,
                archived: false,
              }
              board.tasks.push(task as unknown as Task)
              created.push(task)
            }
          })

          for (const t of created) {
            broadcast("task.created", { task: t })
          }

          // Write a real MDX artifact for each imported task so "View Artifact" works
          // and the file shows up in the board mirror. Mirrors what kanban/server.ts does
          // for REST-initiated mutations.
          if (created.length > 0) {
            const board = await getBoard()
            for (const t of created) {
              try {
                await writeTaskMdx(t, KANBAN_DIR, board)
              } catch (e) {
                await ctx.client.app.log({
                  body: { service: "openkan", level: "warn", message: `writeTaskMdx failed for ${t.id}: ${(e as Error).message}` },
                }).catch(() => {})
              }
            }
          }

          return (
            `kanban_import: ${created.length} created, ${skippedExisting.length} already present; ` +
            `scanned ${scanned} file(s), skipped ${skipped} (dir(s) excluded).`
          )
        },
      }),

      // ─── M7 — ask the user a structured question ────────────────────────────
      // The user can respond via the task view's "Needs you" banner OR via an
      // inline <Ask>/<Choice>/<Input>/<Confirm> block in the MDX (the view's
      // MDX viewer matches the blockId).
      kanban_ask: tool({
        description:
          "Ask the user a structured question. Sets the task state to `waiting-for-input`. After calling this, the user sees the question in the task view; call `kanban_respond` (after the user answers) to read their reply. Optionally include a `blockId` so the question shows up inside the matching <Ask>/<Choice>/<Input>/<Confirm> component in the task MDX; if your MDX already has that component at that line, the user will see the form right there. Otherwise the question appears in the 'Needs you' banner at the top of the task view.",
        args: {
          taskId: tool.schema.string().describe("Task id"),
          type: tool.schema
            .enum(["ask", "choice", "input", "confirm"])
            .describe("Question shape: 'ask' (free text), 'choice' (radio of options), 'input' (single line), 'confirm' (yes/no)"),
          question: tool.schema.string().describe("The question to ask the user"),
          options: tool.schema
            .array(
              tool.schema.object({
                id: tool.schema.string().describe("Stable option id (e.g. 'a', 'b')"),
                label: tool.schema.string().describe("Human-readable option label"),
                description: tool.schema.string().optional().describe("Optional longer description"),
              }),
            )
            .optional()
            .describe("For 'choice' type only: list of options"),
          blockId: tool.schema
            .string()
            .optional()
            .describe("Optional blockId from the rendered MDX; if set, the question is wired into that <Ask>/<Choice>/<Input>/<Confirm> component."),
        },
        async execute(args) {
          const board = await getBoard()
          const task = board.tasks.find((t) => t.id === args.taskId)
          if (!task) throw new Error(`Task ${args.taskId} not found`)
          if (args.type === "choice" && (!args.options || args.options.length === 0)) {
            throw new Error("`options` is required and must be non-empty when type is 'choice'")
          }

          const input = addInput(task.id, KANBAN_DIR, {
            type: args.type,
            question: args.question,
            options: args.options,
            blockId: args.blockId,
          })

          let updated: Task | undefined
          await withWrite(async (b) => {
            const t = b.tasks.find((x) => x.id === task.id)
            if (!t) return
            t.state = "waiting-for-input"
            t.pendingInputs = [...(t.pendingInputs ?? []), input.id]
            t.updatedAt = nowIso()
            updated = t
          })

          const fresh = (await getBoard()).tasks.find((t) => t.id === task.id)
          // Persist the task MDX mirror so the change is durable.
          try {
            await writeTaskMdx(fresh ?? updated!, KANBAN_DIR, await getBoard())
          } catch (_) { /* best-effort */ }

          broadcast("task.updated", fresh ?? updated)
          broadcast("task.input.asked", { taskId: task.id, input })

          return JSON.stringify(
            {
              ok: true,
              input,
              task: fresh ?? updated,
              hint: args.blockId
                ? `Question wired to block ${args.blockId}. The user will see the form inside the MDX.`
                : "Question posted. The user will see it in the task view's 'Needs you' banner.",
            },
            null,
            2,
          )
        },
      }),

      // ─── M7 — read the user's response ──────────────────────────────────────
      kanban_respond: tool({
        description:
          "Read-only. Returns the most recent responded input for a task — i.e. the user's answer to the last `kanban_ask` they saw. If nothing has been answered yet, returns 'no response yet'. Poll this after a `kanban_ask` to learn the user's reply.",
        args: {
          taskId: tool.schema.string().describe("Task id"),
        },
        async execute(args) {
          const inputs = listInputs(args.taskId, KANBAN_DIR)
          const responded = inputs.filter((i) => i.status === "responded")
          if (responded.length === 0) return "no response yet"
          const latest = responded[0] // listInputs sorts newest first
          return JSON.stringify(
            {
              ok: true,
              inputId: latest.id,
              type: latest.type,
              question: latest.question,
              response: latest.response ?? null,
              responseOptionId: latest.responseOptionId ?? null,
              respondedAt: latest.respondedAt,
            },
            null,
            2,
          )
        },
      }),

      // ─── M8 — read comments for a task ──────────────────────────────────────
      kanban_comments: tool({
        description:
          "Read-only. Returns comments for a task with block context (blockId, line, source excerpt, author, createdAt). Use this to see what the user has annotated on the task MDX before continuing work. By default resolved comments are skipped.",
        args: {
          taskId: tool.schema.string().describe("Task id"),
          includeResolved: tool.schema
            .boolean()
            .optional()
            .describe("Include resolved comments (default false)"),
        },
        async execute(args) {
          const board = await getBoard()
          const task = board.tasks.find((t) => t.id === args.taskId)
          if (!task) throw new Error(`Task ${args.taskId} not found`)

          let comments = listComments(args.taskId, KANBAN_DIR)
          if (!args.includeResolved) comments = comments.filter((c) => !c.resolved)

          // Read the MDX once for excerpts.
          let lines: string[] = []
          try {
            const mdxPath = join(KANBAN_DIR, task.artifacts.mdxPath)
            if (existsSync(mdxPath)) {
              lines = readFileSync(mdxPath, "utf8").split("\n")
            }
          } catch (_) { /* fall back to no excerpts */ }

          const enriched = comments.map((c) => {
            const excerpt = lines[c.line - 1]?.trim() ?? ""
            return {
              id: c.id,
              blockId: c.blockId,
              line: c.line,
              excerpt: excerpt.slice(0, 160),
              text: c.text,
              author: c.author,
              createdAt: c.createdAt,
              resolved: c.resolved,
            }
          })

          return JSON.stringify({ ok: true, count: enriched.length, comments: enriched }, null, 2)
        },
      }),

      // ─── M9 — dry-run a TSX snippet ─────────────────────────────────────────
      kanban_preview: tool({
        description:
          "Dry-run a TSX snippet (the body of a <Preview> component). Returns the compiled JS, or an error string you can iterate on. The 32 KB limit matches the sandbox. This does NOT render — the UI's <Preview> component calls /api/preview at view time.",
        args: {
          tsx: tool.schema
            .string()
            .describe("TSX source — must be plain function components, no hooks, no imports"),
          props: tool.schema
            .string()
            .optional()
            .describe("Optional JSON-stringified props object; default '{}'"),
        },
        async execute(args) {
          if (Buffer.byteLength(args.tsx, "utf-8") > 32768) {
            return JSON.stringify({ ok: false, error: "TSX exceeds 32 KB limit." })
          }
          let parsedProps: Record<string, unknown> = {}
          if (args.props && args.props.length > 0) {
            try {
              parsedProps = JSON.parse(args.props)
            } catch (e: any) {
              return JSON.stringify({ ok: false, error: `Invalid props JSON: ${e?.message ?? e}` })
            }
          }
          const result = await compileTsx(args.tsx, { maxBytes: 32768 })
          if (result.error) {
            return JSON.stringify({ ok: false, error: result.error })
          }
          return JSON.stringify({ ok: true, js: result.js, props: parsedProps }, null, 2)
        },
      }),

      // ─── M10 — archive a task ─────────────────────────────────────────────
      kanban_archive: tool({
        description: "Archive a task. Archived tasks are hidden from the board view but remain searchable and can be restored.",
        args: {
          taskId: tool.schema.string().describe("Task id"),
        },
        async execute(args) {
          let updated: Task | undefined;
          await withWrite(async (board) => {
            const t = board.tasks.find(x => x.id === args.taskId);
            if (!t) throw new Error(`Task ${args.taskId} not found`);
            t.archived = true;
            t.updatedAt = nowIso();
            updated = { ...t };
          });
          if (!updated) throw new Error(`Task ${args.taskId} not found`);
          const board = await getBoard();
          await writeTaskMdx(updated, KANBAN_DIR, board);
          broadcast("task.updated", { task: updated });
          recordEvent(KANBAN_DIR, "task.archived", {
            taskId: args.taskId,
            author: "user",
            summary: `archived '${updated.title}'`,
            payload: {},
          });
          return `Archived task ${args.taskId}: ${updated.title}`;
        },
      }),

      // ─── M10 — restore an archived task ───────────────────────────────────
      kanban_restore: tool({
        description: "Restore an archived task back to the board.",
        args: {
          taskId: tool.schema.string().describe("Task id"),
        },
        async execute(args) {
          let updated: Task | undefined;
          await withWrite(async (board) => {
            const t = board.tasks.find(x => x.id === args.taskId);
            if (!t) throw new Error(`Task ${args.taskId} not found`);
            t.archived = false;
            t.updatedAt = nowIso();
            updated = { ...t };
          });
          if (!updated) throw new Error(`Task ${args.taskId} not found`);
          const board = await getBoard();
          await writeTaskMdx(updated, KANBAN_DIR, board);
          broadcast("task.updated", { task: updated });
          recordEvent(KANBAN_DIR, "task.restored", {
            taskId: args.taskId,
            author: "user",
            summary: `restored '${updated.title}'`,
            payload: {},
          });
          return `Restored task ${args.taskId}: ${updated.title}`;
        },
      }),

      // ─── M10 — batch-organize tasks ───────────────────────────────────────
      kanban_organize: tool({
        description: "Apply a batch of operations (set-tags, add-tags, move, archive, restore, set-priority, set-effort, set-category, rederive, add-area) to one or more tasks in a single atomic step. Records a single changelog event for the entire batch.",
        args: {
          operations: tool.schema.array(
            tool.schema.object({
              kind: tool.schema.enum(["rederive", "set-tags", "add-tags", "remove-tag", "set-priority", "set-effort", "set-category", "move", "archive", "restore", "add-area"]).describe("Operation kind"),
              taskId: tool.schema.string().describe("Task id"),
              tags: tool.schema.array(tool.schema.string()).optional().describe("Tags (for set-tags, add-tags)"),
              tag: tool.schema.string().optional().describe("Tag to remove (for remove-tag)"),
              priority: tool.schema.enum(["low", "normal", "high", "urgent"]).optional().describe("Priority (for set-priority)"),
              effort: tool.schema.enum(["xs", "s", "m", "l", "xl"]).null().optional().describe("Effort (for set-effort)"),
              category: tool.schema.enum(["frontend", "backend", "infra", "docs", "test", "design", "data", "security", "task"]).optional().describe("Category (for set-category)"),
              column: tool.schema.enum(["backlog", "todo", "doing", "review", "done"]).optional().describe("Target column (for move)"),
              area: tool.schema.string().optional().describe("Area name (for add-area)"),
            }),
          ).describe("Array of operations to apply"),
        },
        async execute(args) {
          // Call the API handler directly (same process)
          const { apiOrganize } = await import("../kanban/server.ts");
          const req = new Request("http://localhost/api/organize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ operations: args.operations }),
          });
          const res = await apiOrganize({ directory: KANBAN_DIR, client: null as any, log: async () => {} }, req);
          const json = await res.json();
          return JSON.stringify(json, null, 2);
        },
      }),

      // ─── M10 — git attribution for a task ─────────────────────────────────
      kanban_git_attribution: tool({
        description: "Read-only. Returns all git commits attributed to a task based on source file overlap and keyword matching.",
        args: {
          taskId: tool.schema.string().describe("Task id"),
          since: tool.schema.string().optional().describe("ISO date or git ref — only show commits since this date/ref"),
        },
        async execute(args) {
          const board = await getBoard();
          const task = board.tasks.find(t => t.id === args.taskId);
          if (!task) throw new Error(`Task ${args.taskId} not found`);
          const root = getProjectRoot();
          if (!isGitRepo(root)) return JSON.stringify({ ok: false, error: "Not a git repository" });
          const attributed = attributeCommitsToTasks(
            root,
            [{ id: task.id, title: task.title, source: task.source }],
            { since: args.since },
          );
          const commits = attributed.get(task.id) ?? [];
          return JSON.stringify({ ok: true, taskId: task.id, commits }, null, 2);
        },
      }),

      // ─── M10 — changelog ─────────────────────────────────────────────────
      kanban_changelog: tool({
        description: "Read-only. Returns recent changelog events, optionally filtered by task, author, kind, or time range.",
        args: {
          taskId: tool.schema.string().optional().describe("Filter to a specific task id"),
          since: tool.schema.string().optional().describe("ISO timestamp or date string"),
          kind: tool.schema.array(tool.schema.string()).optional().describe("Event kinds to include (e.g. task.created, task.moved)"),
          limit: tool.schema.number().optional().describe("Max events to return (default 100)"),
        },
        async execute(args) {
          const kinds = (args.kind as ChangelogKind[] | undefined) ?? undefined;
          const result = readEvents(KANBAN_DIR, {
            taskId: args.taskId,
            since: args.since,
            kind: kinds as any,
            limit: args.limit ?? 100,
          });
          return JSON.stringify({ ok: true, ...result }, null, 2);
        },
      }),

      // ─── M10 — search tasks ───────────────────────────────────────────────
      kanban_search: tool({
        description: "Read-only. Full-text search across task titles, descriptions, tags, assignees, and MDX content. Returns tasks with `matchIn` field listing which fields matched.",
        args: {
          query: tool.schema.string().optional().describe("Free-text search query (matches title, description, tags, assignees, MDX content)"),
          column: tool.schema.enum(["backlog", "todo", "doing", "review", "done"]).optional().describe("Filter by column"),
          tags: tool.schema.array(tool.schema.string()).optional().describe("Filter to tasks containing ALL these tags (AND)"),
          assignee: tool.schema.string().optional().describe("Filter to tasks assigned to this user"),
          priority: tool.schema.enum(["low", "normal", "high", "urgent"]).optional().describe("Filter by priority"),
          category: tool.schema.enum(["frontend", "backend", "infra", "docs", "test", "design", "data", "security", "task"]).optional().describe("Filter by category"),
          includeArchived: tool.schema.boolean().optional().describe("Include archived tasks (default false)"),
          limit: tool.schema.number().optional().describe("Max results (default 50)"),
          offset: tool.schema.number().optional().describe("Skip first N results for pagination"),
        },
        async execute(args) {
          const params = new URLSearchParams();
          if (args.query) params.set("q", args.query);
          if (args.column) params.set("column", args.column);
          for (const tag of (args.tags ?? [])) params.append("tags", tag);
          if (args.assignee) params.set("assignee", args.assignee);
          if (args.priority) params.set("priority", args.priority);
          if (args.category) params.set("category", args.category);
          if (args.includeArchived) params.set("includeArchived", "true");
          if (args.limit) params.set("limit", String(args.limit));
          if (args.offset) params.set("offset", String(args.offset));

          const url = `http://127.0.0.1:7777/api/search?${params.toString()}`;
          const res = await fetch(url);
          if (!res.ok) return JSON.stringify({ ok: false, error: `Search failed: ${res.statusText}` });
          const json = await res.json() as { results: any[]; total: number };

          if (json.results.length === 0) return "No tasks match.";

          return json.results
            .map((t) => {
              const parts: string[] = [`[${t.id}]`, t.title];
              parts.push(`column=${t.column}`);
              if (t.matchIn?.length) parts.push(`match=${t.matchIn.join(",")}`);
              if (t.priority) parts.push(`priority=${t.priority}`);
              if (t.category) parts.push(`category=${t.category}`);
              if (t.tags?.length) parts.push(`tags=${t.tags.join(",")}`);
              return parts.join(" ");
            })
            .join("\n") + `\n\n${json.total} total result(s)`;
        },
      }),

      // ─── M10 — bulk operations ───────────────────────────────────────────
      kanban_bulk: tool({
        description: "Apply a batch operation across multiple tasks atomically. Records one changelog event for the entire batch.",
        args: {
          operation: tool.schema.object({
            kind: tool.schema.enum(["move", "set-priority", "set-category", "add-tags", "remove-tag", "assign", "archive", "restore", "delete"]).describe("Operation kind"),
            taskIds: tool.schema.array(tool.schema.string()).describe("Task ids to operate on"),
            column: tool.schema.enum(["backlog", "todo", "doing", "review", "done"]).optional().describe("Target column (for move)"),
            order: tool.schema.number().optional().describe("Order index (for move)"),
            priority: tool.schema.enum(["low", "normal", "high", "urgent"]).optional().describe("Priority (for set-priority)"),
            category: tool.schema.enum(["frontend", "backend", "infra", "docs", "test", "design", "data", "security", "task"]).optional().describe("Category (for set-category)"),
            tags: tool.schema.array(tool.schema.string()).optional().describe("Tags (for add-tags)"),
            tag: tool.schema.string().optional().describe("Tag to remove (for remove-tag)"),
            assignee: tool.schema.string().optional().describe("Assignee (for assign)"),
          }).describe("The bulk operation to apply"),
        },
        async execute(args) {
          const { apiBulk } = await import("../kanban/server.ts");
          const req = new Request("http://127.0.0.1:7777/api/tasks/bulk", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ operation: args.operation }),
          });
          const res = await apiBulk({ directory: KANBAN_DIR, client: null as any, log: async () => {} }, req);
          const json = await res.json();
          return JSON.stringify(json, null, 2);
        },
      }),
    },
  }
}

export default OpenKanToolsPlugin

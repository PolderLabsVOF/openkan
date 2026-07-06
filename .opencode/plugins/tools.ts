// OpenKan — custom OpenCode tools.
// Loaded by OpenCode as a second plugin file (sibling of plugins/kanban.ts)
// because it lives under .opencode/plugins/.
//
// Exposes four tools to the agent:
//   - kanban_add
//   - kanban_move
//   - kanban_start
//   - kanban_view
//
// Each tool mutates the shared board (via withWrite / getBoard) and broadcasts
// events over the local SSE server (via getServer) so the UI updates live.

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { withWrite, newId, getBoard, type Task } from "../kanban/board.ts"
import { getServer } from "../kanban/server.ts"

const COLUMNS = ["backlog", "todo", "doing", "review", "done"] as const
type ColumnId = (typeof COLUMNS)[number]

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
        },
        async execute(args) {
          const now = new Date().toISOString()
          const column = asColumn(args.column, "todo")
          const task: Task = {
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
          }

          await withWrite(async (board) => {
            const col = board.columns.find((c) => c.id === column) ?? board.columns[1]
            task.column = col.id
            const inCol = board.tasks.filter((t) => t.column === task.column)
            task.order = inCol.length
            task.artifact = `.openkan/tasks/${task.id}.mdx`
            board.tasks.push(task)
          })

          const fresh = (await getBoard()).tasks.find((t) => t.id === task.id)
          broadcast("task.created", { task: fresh ?? task })
          return `Added task ${task.id}: ${task.title}`
        },
      }),

      kanban_move: tool({
        description: "Move a task to a different column and/or reorder it.",
        args: {
          taskId: tool.schema.string().describe("Task id, e.g. 'tsk_abc123'"),
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
          "Read-only: list tasks on the board, optionally filtered by column and/or status.",
        args: {
          column: tool.schema
            .enum(["backlog", "todo", "doing", "review", "done"])
            .optional()
            .describe("Filter by column"),
          status: tool.schema
            .enum(["idle", "running", "done", "failed", "cancelled"])
            .optional()
            .describe("Filter by status"),
        },
        async execute(args) {
          const board = await getBoard()
          let tasks = board.tasks
          if (args.column) tasks = tasks.filter((t) => t.column === args.column)
          if (args.status) tasks = tasks.filter((t) => t.status === args.status)
          tasks = [...tasks].sort((a, b) => {
            const ca = board.columns.findIndex((c) => c.id === a.column)
            const cb = board.columns.findIndex((c) => c.id === b.column)
            if (ca !== cb) return ca - cb
            return a.order - b.order
          })
          if (tasks.length === 0) return "No tasks match."
          return tasks
            .map(
              (t) =>
                `[${t.id}] ${t.title} — column=${t.column} status=${t.status} agent=${t.agent || "(default)"}`,
            )
            .join("\n")
        },
      }),
    },
  }
}

export default OpenKanToolsPlugin

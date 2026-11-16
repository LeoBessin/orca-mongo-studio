// Saved tasks in `storage:own`, under one key. The worker is the only writer; panels hear changes
// through `tasks.changed`. A task names connections by id, so deleting a connection deletes the
// tasks that use it, as it does its query history and saved pipelines.
import { randomUUID } from 'node:crypto'
import type { OrcaWorkerApi } from 'orca/worker'
import { checkTaskName, checkTaskRequest, freeTaskName, taskConnections, type Task, type TaskRequest, type TaskRun } from '../shared/tasks'
import { isObject, toJson } from './json'
import { invalid } from './query'

const TASKS = 'tasks.v1'
/** Orca caps a storage value at 256 KiB; leave room for the wrapper. */
const STORED_MAX = 250 * 1024

function isTask(v: unknown): v is Task {
  return isObject(v) && typeof v.id === 'string' && typeof v.name === 'string' && isObject(v.request) && typeof v.request.kind === 'string'
}

export class TaskStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly orca: OrcaWorkerApi) {}

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  async list(): Promise<Task[]> {
    const raw = await this.orca.storage.get(TASKS)
    return isObject(raw) && Array.isArray(raw.items) ? raw.items.filter(isTask) : []
  }

  async get(id: string): Promise<Task> {
    const task = (await this.list()).find((t) => t.id === id)
    if (!task) throw invalid('This task no longer exists.')
    return task
  }

  private async write(items: Task[]): Promise<Task[]> {
    const value = toJson({ items })
    if (JSON.stringify(value).length > STORED_MAX) throw invalid('Saved tasks are limited to about 250 KB in all. Delete some, or shorten a long pipeline.')
    await this.orca.storage.set(TASKS, value)
    return items
  }

  /** A new task, or (with `id`) new settings for one; its last run is kept. */
  save(id: string | undefined, name: unknown, request: unknown, now = Date.now()): Promise<{ tasks: Task[]; id: string }> {
    const cleanName = checkTaskName(name)
    const cleanRequest: TaskRequest = checkTaskRequest(request)
    return this.exclusive(async () => {
      const items = await this.list()
      const others = items.filter((t) => t.id !== id)
      if (others.some((t) => t.name.toLowerCase() === cleanName.toLowerCase())) throw invalid(`A task is already named "${cleanName}". Choose another name.`)
      const at = id ? items.findIndex((t) => t.id === id) : -1
      if (id && at < 0) throw invalid('This task no longer exists.')
      const task: Task = at >= 0 ? { ...items[at]!, name: cleanName, request: cleanRequest, updatedAt: now } : { id: randomUUID(), name: cleanName, request: cleanRequest, createdAt: now, updatedAt: now }
      if (at >= 0) items[at] = task
      else items.push(task)
      return { tasks: await this.write(items), id: task.id }
    })
  }

  rename(id: string, name: unknown, now = Date.now()): Promise<Task[]> {
    const clean = checkTaskName(name)
    return this.exclusive(async () => {
      const items = await this.list()
      const task = items.find((t) => t.id === id)
      if (!task) throw invalid('This task no longer exists.')
      if (items.some((t) => t.id !== id && t.name.toLowerCase() === clean.toLowerCase())) throw invalid(`A task is already named "${clean}". Choose another name.`)
      task.name = clean
      task.updatedAt = now
      return this.write(items)
    })
  }

  duplicate(id: string, now = Date.now()): Promise<{ tasks: Task[]; id: string }> {
    return this.exclusive(async () => {
      const items = await this.list()
      const source = items.find((t) => t.id === id)
      if (!source) throw invalid('This task no longer exists.')
      const copy: Task = { id: randomUUID(), name: freeTaskName(`${source.name} (copy)`, items.map((t) => t.name)), request: JSON.parse(JSON.stringify(source.request)) as TaskRequest, createdAt: now, updatedAt: now }
      items.splice(items.indexOf(source) + 1, 0, copy)
      return { tasks: await this.write(items), id: copy.id }
    })
  }

  remove(id: string): Promise<Task[]> {
    return this.exclusive(async () => this.write((await this.list()).filter((t) => t.id !== id)))
  }

  recordRun(id: string, run: TaskRun): Promise<Task[]> {
    return this.exclusive(async () => {
      const items = await this.list()
      const task = items.find((t) => t.id === id)
      if (!task) return items
      task.lastRun = run
      return this.write(items)
    })
  }

  /** Deletes the tasks that use a connection; answers whether any were. */
  forgetConnection(connectionId: string): Promise<boolean> {
    return this.exclusive(async () => {
      const items = await this.list()
      const keep = items.filter((t) => !taskConnections(t.request).includes(connectionId))
      if (keep.length === items.length) return false
      await this.write(keep)
      return true
    })
  }
}

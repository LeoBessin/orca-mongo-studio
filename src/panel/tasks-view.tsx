// The Tasks tab, and the "Save as task" section the Import, Export/Copy and Compare tabs share.
import {
  Badge,
  Box,
  Button,
  Callout,
  Collapsible,
  EmptyState,
  IconButton,
  Input,
  KeyValue,
  read,
  RelativeTime,
  Row,
  Skeleton,
  Table,
  Text,
  Toolbar,
  update,
  type OrcaNode
} from 'orca'
import { describeTask, taskConnections, taskKindLabel, taskWriteConnection, type Task } from '../shared/tasks'
import { aguard, connectionName, isReadOnly, numberText } from './admin-state'
import { jobRunning } from './data-state'
import { JobProgress } from './job-view'
import { connections, errorText } from './state'
import {
  cancelTaskRun,
  closeTasks,
  deleteTask,
  duplicateTask,
  openTaskInTab,
  openTasks,
  renameTask,
  runTask,
  saveTabAsTask,
  saveTaskDownload,
  sayTasks,
  selectTask,
  setTaskName,
  startRename,
  taskList,
  tasksError,
  tasksUi
} from './tasks-state'

/** Runs an action and shows its error in the Tasks tab. */
function tguard(run: () => Promise<unknown> | unknown): () => Promise<void> {
  return async () => {
    try {
      await run()
    } catch (error) {
      sayTasks('danger', errorText(error))
    }
  }
}

const STATUS_TEXT = { done: 'Done', failed: 'Failed', cancelled: 'Cancelled', running: 'Running' } as const

function missingConnection(task: Task): boolean {
  const known = new Set(read(connections)?.connections.map((c) => c.id) ?? [])
  return taskConnections(task.request).some((id) => !known.has(id))
}

function Selected({ task }: { task: Task }): OrcaNode {
  const u = read(tasksUi)
  const box = u.runs[task.id]
  const running = jobRunning(box)
  const writesTo = taskWriteConnection(task.request)
  const blocked = isReadOnly(writesTo)
  const renaming = u.renaming?.id === task.id ? u.renaming : undefined
  const confirm = u.confirmRun?.id === task.id ? u.confirmRun : undefined
  const last = task.lastRun
  return (
    <Box gap="sm">
      <Toolbar label={`${task.name} actions`} gap="xs">
        <Button size="sm" icon="play" variant="solid" tone="accent" disabled={running || Boolean(confirm) || blocked} onPress={tguard(() => runTask(task.id))}>{running ? 'Running…' : 'Run'}</Button>
        <Button size="sm" icon="open-external" variant="ghost" onPress={tguard(() => openTaskInTab(task.id))}>Open in its tab</Button>
        <IconButton icon="edit" label="Rename" variant="ghost" size="sm" onPress={() => startRename(task.id)} />
        <IconButton icon="copy" label="Duplicate" variant="ghost" size="sm" onPress={tguard(() => duplicateTask(task.id))} />
        <IconButton icon="delete" label={`Delete ${task.name}`} variant="ghost" tone="danger" size="sm" onPress={() => update(tasksUi, (x) => ({ ...x, confirmDelete: task.id, confirmRun: undefined }))} />
      </Toolbar>
      {blocked ? <Text size="xs" tone="warning">{`It writes to ${connectionName(writesTo!)}, which is read only: turn that off in the connection's settings to run it.`}</Text> : null}
      {renaming ? (
        <Row gap="xs" align="end">
          <Box grow>
            <Input label="Task name" value={renaming.name} onChange={(name) => update(tasksUi, (x) => ({ ...x, renaming: { id: task.id, name } }))} onSubmit={(name) => void tguard(() => renameTask(task.id, name))()} />
          </Box>
          <Button variant="solid" tone="accent" onPress={tguard(() => renameTask(task.id, renaming.name))}>Rename</Button>
          <Button variant="ghost" onPress={() => update(tasksUi, (x) => ({ ...x, renaming: undefined }))}>Cancel</Button>
        </Row>
      ) : null}
      {u.confirmDelete === task.id ? (
        <Callout tone="danger" icon="warning" title={`Delete the task "${task.name}"?`}>
          <Box gap="sm">
            <Text>Only the saved task is removed. Its collections and files are not touched.</Text>
            <Row gap="xs">
              <Button variant="solid" tone="danger" onPress={tguard(() => deleteTask(task.id))}>Delete task</Button>
              <Button variant="ghost" onPress={() => update(tasksUi, (x) => ({ ...x, confirmDelete: undefined }))}>Cancel</Button>
            </Row>
          </Box>
        </Callout>
      ) : null}
      {confirm ? (
        <Callout tone="danger" icon="warning" title={confirm.title}>
          <Box gap="sm">
            <Text>{`${confirm.text}${confirm.exists ? (confirm.count === null ? '' : ` It holds ${numberText(confirm.count)} document${confirm.count === 1 ? '' : 's'} now.`) : ' It does not exist yet.'}`}</Text>
            <Row gap="xs">
              <Button variant="solid" tone="danger" onPress={tguard(() => runTask(task.id, true))}>Run the task</Button>
              <Button variant="ghost" onPress={() => update(tasksUi, (x) => ({ ...x, confirmRun: undefined }))}>Cancel</Button>
            </Row>
          </Box>
        </Callout>
      ) : null}
      <JobProgress box={box} what={taskKindLabel(task.request).toLowerCase()} onCancel={tguard(() => cancelTaskRun(task.id))} onSave={tguard(() => saveTaskDownload(task.id))} />
      <KeyValue label={`${task.name} settings`} items={describeTask(task.request, connectionName)} />
      {last ? (
        <Box gap="none">
          <Row gap="xs" align="center">
            <Badge tone={last.status === 'done' ? (last.errorCount ? 'warning' : 'success') : last.status === 'failed' ? 'danger' : 'neutral'}>{STATUS_TEXT[last.status]}</Badge>
            <Text size="xs" muted>
              {'Last run '}
              <RelativeTime at={last.at} />
              {` · ${Math.max(1, Math.round(last.ms / 1000))} s${last.errorCount ? ` · ${numberText(last.errorCount)} error${last.errorCount === 1 ? '' : 's'}` : ''}`}
            </Text>
          </Row>
          <Text size="sm">{last.summary}</Text>
        </Box>
      ) : (
        <Text size="xs" muted>Not run yet.</Text>
      )}
    </Box>
  )
}

export function TasksView(): OrcaNode {
  const list = read(taskList)
  const error = read(tasksError)
  const u = read(tasksUi)
  const selected = list?.find((t) => t.id === u.selected)
  return (
    <Box gap="sm">
      <Row gap="xs" align="center" justify="between">
        <Box gap="none" grow>
          <Text weight="semibold">Saved tasks</Text>
          <Text size="xs" muted>Imports, exports, copies, compares and syncs, saved with their options and run when you choose. Nothing runs on a schedule.</Text>
        </Box>
        <IconButton icon="refresh" label="Reload the tasks" variant="ghost" size="sm" onPress={() => openTasks()} />
        <IconButton icon="close" label="Close saved tasks" variant="ghost" size="sm" onPress={closeTasks} />
      </Row>
      {u.notice ? (
        <Callout tone={u.notice.tone} icon={u.notice.tone === 'danger' ? 'error' : u.notice.tone === 'success' ? 'check' : 'info'}>
          <Row justify="between" align="center">
            <Text>{u.notice.text}</Text>
            <IconButton icon="close" label="Dismiss" variant="ghost" size="xs" onPress={() => update(tasksUi, (x) => ({ ...x, notice: undefined }))} />
          </Row>
        </Callout>
      ) : null}
      {error ? <Callout tone="danger" icon="error" title="Could not read the saved tasks">{error}</Callout> : null}
      {!list && !error ? <Skeleton lines={3} label="Loading saved tasks" /> : null}
      {list && list.length === 0 ? (
        <EmptyState icon="rocket" title="No saved tasks" description={'Set up an import, an export or copy, or a compare, in its tab, then press "Save as task" there.'} />
      ) : null}
      {list && list.length ? (
        <Table
          label="Saved tasks"
          columns={[
            { key: 'name', label: 'Name', minWidth: 'sm' },
            { key: 'kind', label: 'Kind', width: 'xs' },
            { key: 'last', label: 'Last run', width: 'sm', hideBelow: 'sm' }
          ]}
          rows={list.map((t) => ({
            key: t.id,
            cells: {
              name: missingConnection(t) ? `${t.name} (connection missing)` : t.name,
              kind: taskKindLabel(t.request),
              last: jobRunning(u.runs[t.id]) ? 'running' : t.lastRun ? { type: 'relative', at: t.lastRun.at, format: 'short' } : 'never'
            }
          }))}
          selectionMode="single"
          selected={u.selected ? [u.selected] : []}
          maxHeight="md"
          onSelectionChange={({ keys }) => selectTask(keys[0])}
        />
      ) : null}
      {selected ? <Selected task={selected} /> : list && list.length ? <Text size="xs" muted>Select a task to run it, open it in its tab, rename or delete it.</Text> : null}
    </Box>
  )
}

/**
 * "Save as task" for a data tab: saves what the tab is set up to do. `kinds` lists what the tab can
 * save (Compare saves a comparison or a sync).
 */
export function TaskSaver({ tabId, task, taskName, placeholder, kinds }: {
  tabId: string
  task: { id: string; name: string; kind?: 'compare' | 'sync' } | undefined
  taskName: string
  placeholder: string
  kinds: { kind: 'export' | 'import' | 'compare' | 'sync'; label: string }[]
}): OrcaNode {
  return (
    <Collapsible title="Save as task" description={task ? `Saved as "${task.name}"` : 'Run it again later from Saved tasks'}>
      <Box gap="sm">
        <Input label="Task name" placeholder={placeholder} value={taskName} onChange={(v) => setTaskName(tabId, v)} />
        <Row gap="xs" wrap>
          {kinds.map((k) => {
            const canUpdate = task && (task.kind === undefined || task.kind === k.kind)
            return canUpdate ? (
              <Button key={`u-${k.kind}`} size="sm" icon="check" variant="solid" tone="accent" onPress={aguard(tabId, () => saveTabAsTask(tabId, k.kind, true))}>{`Update "${task.name}"`}</Button>
            ) : null
          })}
          {kinds.map((k) => (
            <Button key={`n-${k.kind}`} size="sm" icon="add" variant={task ? 'ghost' : 'solid'} tone={task ? 'neutral' : 'accent'} onPress={aguard(tabId, () => saveTabAsTask(tabId, k.kind, false))}>{task ? `${k.label} as a new task` : k.label}</Button>
          ))}
          <Button size="sm" icon="rocket" variant="ghost" onPress={() => openTasks(task?.id)}>Saved tasks</Button>
        </Row>
      </Box>
    </Collapsible>
  )
}

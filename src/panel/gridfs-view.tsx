// The GridFS tab: the files table, the selected file's details, preview and actions, and upload.
import {
  Box,
  Button,
  Callout,
  Checkbox,
  CodeView,
  Collapsible,
  IconButton,
  Input,
  KeyValue,
  RadioGroup,
  read,
  Row,
  Skeleton,
  Table,
  Text,
  Textarea,
  type KeyValueItem,
  type OrcaNode
} from 'orca'
import { idKey, isoDate, valueText } from '../shared/ejson-view'
import { adminTabs, aguard, changeAdmin, closeAdmin, connectionName, isReadOnly, numberText } from './admin-state'
import { NoticeBar } from './admin-notice'
import { bytesText, jobRunning } from './data-state'
import { cancelGridJob, deleteSelected, downloadFile, loadFiles, renameSelected, saveFile, selectedFile, selectFile, uploadFile, type GridfsTab } from './gridfs-state'
import { JobProgress } from './job-view'

function language(name: string, type?: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (type?.includes('json') || ext === 'json') return 'json'
  if (ext === 'md' || type === 'text/markdown') return 'markdown'
  if (ext === 'js' || ext === 'mjs') return 'javascript'
  if (ext === 'html' || ext === 'xml' || ext === 'css' || ext === 'yaml' || ext === 'sql') return ext
  return 'text'
}

function Selected({ t }: { t: GridfsTab }): OrcaNode {
  const f = selectedFile(t)
  if (!f) return <Text size="xs" muted>Select a file for its details, a preview, and to download, rename or delete it.</Text>
  const p = t.preview?.key === t.selected ? t.preview : undefined
  const items: KeyValueItem[] = [
    { label: '_id', value: valueText(f.id, 80), code: true },
    { label: 'Size', value: `${bytesText(f.length)} (${numberText(f.length)} bytes)` },
    { label: 'Uploaded', value: f.uploadDate ? isoDate(f.uploadDate) : 'unknown' },
    { label: 'Chunk size', value: bytesText(f.chunkSize) }
  ]
  if (f.contentType) items.push({ label: 'Content type', value: f.contentType })
  if (f.metadata) items.push({ label: 'Metadata', value: f.metadata, code: true })
  if (p?.data && p.data.chunks !== p.data.expectedChunks) items.push({ label: 'Chunks', value: `${p.data.chunks} of ${p.data.expectedChunks}: the file is incomplete`, tone: 'danger' })
  const d = t.download
  const running = jobRunning(d.job)
  return (
    <Box gap="sm">
      <KeyValue label={`${f.filename} details`} items={items} />
      {p?.loading ? <Skeleton lines={3} label="Reading the start of the file" /> : null}
      {p?.error ? <Callout tone="danger" icon="error">{p.error}</Callout> : null}
      {p?.data?.text !== undefined ? (
        <Box gap="xs">
          <CodeView label={`Start of ${f.filename}`} code={p.data.text} language={language(f.filename, f.contentType)} lineNumbers maxHeight="md" />
          {p.data.cut ? <Text size="xs" muted>{`The first ${bytesText(64 * 1024)} of ${bytesText(f.length)}.`}</Text> : null}
        </Box>
      ) : p?.data?.binary ? (
        <Text size="xs" muted>Binary content: download it to open it.</Text>
      ) : null}
      <Collapsible title="Download" description={d.destination === 'download' ? 'The save dialog' : 'To a path'} defaultOpen>
        <Box gap="xs">
          <RadioGroup
            label="Save to"
            labelHidden
            orientation="horizontal"
            value={d.destination}
            options={[
              { value: 'download', label: 'The save dialog' },
              { value: 'path', label: 'A path' }
            ]}
            onChange={(v) => changeAdmin(t.id, 'gridfs', (x) => ({ download: { ...x.download, destination: v as 'download' | 'path' } }))}
          />
          {d.destination === 'path' ? (
            <Box gap="xs">
              <Input label="Path" value={d.path} placeholder={`~/Downloads (or ~/Downloads/${f.filename.split('/').pop()})`} onChange={(v) => changeAdmin(t.id, 'gridfs', (x) => ({ download: { ...x.download, path: v } }))} />
              <Checkbox label="Replace an existing file" checked={d.overwrite} onChange={(overwrite) => changeAdmin(t.id, 'gridfs', (x) => ({ download: { ...x.download, overwrite } }))} />
            </Box>
          ) : null}
          <Row gap="xs">
            <Button icon="download" disabled={running} onPress={aguard(t.id, () => downloadFile(t.id))}>{running ? 'Reading…' : d.destination === 'download' ? 'Prepare the download' : 'Download'}</Button>
          </Row>
          <JobProgress box={d.job} what="download" onCancel={aguard(t.id, () => cancelGridJob(t.id, 'download'))} onSave={aguard(t.id, () => saveFile(t.id))} />
        </Box>
      </Collapsible>
      {isReadOnly(t.connectionId) ? null : (
        <Row gap="xs" align="end">
          <Box grow>
            <Input label="Name" value={t.rename} onChange={(v) => changeAdmin(t.id, 'gridfs', () => ({ rename: v }))} onSubmit={() => void aguard(t.id, () => renameSelected(t.id))()} />
          </Box>
          <Button icon="edit" disabled={!t.rename.trim() || t.rename.trim() === f.filename} onPress={aguard(t.id, () => renameSelected(t.id))}>Rename</Button>
          <IconButton icon="delete" label={`Delete ${f.filename}`} variant="ghost" tone="danger" onPress={() => changeAdmin(t.id, 'gridfs', (x) => ({ confirmDelete: x.selected }))} />
        </Row>
      )}
      {t.confirmDelete === t.selected ? (
        <Callout tone="danger" icon="warning" title={`Delete ${f.filename}?`}>
          <Box gap="sm">
            <Text>{`Its file document and its ${numberText(Math.ceil(f.length / Math.max(1, f.chunkSize)))} chunks are deleted from ${t.db}.${t.bucket}.files and .chunks.`}</Text>
            <Row gap="xs">
              <Button variant="solid" tone="danger" onPress={aguard(t.id, () => deleteSelected(t.id))}>Delete file</Button>
              <Button variant="ghost" onPress={() => changeAdmin(t.id, 'gridfs', () => ({ confirmDelete: undefined }))}>Cancel</Button>
            </Row>
          </Box>
        </Callout>
      ) : null}
    </Box>
  )
}

function Upload({ t }: { t: GridfsTab }): OrcaNode {
  const u = t.upload
  const set = (change: Partial<GridfsTab['upload']>): void => changeAdmin(t.id, 'gridfs', (x) => ({ upload: { ...x.upload, ...change } }))
  const running = jobRunning(u.job)
  return (
    <Collapsible title="Upload a file" description={`Into ${t.bucket}`} open={u.open} onChange={(open) => set({ open })}>
      <Box gap="xs">
        <RadioGroup
          label="Source"
          orientation="horizontal"
          value={u.sourceKind}
          options={[
            { value: 'path', label: 'A file on this computer' },
            { value: 'paste', label: 'Pasted text' }
          ]}
          onChange={(v) => set({ sourceKind: v as 'path' | 'paste' })}
        />
        {u.sourceKind === 'path' ? <Input label="Path" value={u.path} placeholder="~/Documents/report.pdf" onChange={(v) => set({ path: v })} /> : <Textarea label="Text" rows={5} value={u.text} onChange={(v) => set({ text: v })} />}
        <Box columns={2} gap="xs">
          <Input label="File name" value={u.filename} placeholder={u.sourceKind === 'path' ? 'As on disk' : 'notes.txt'} onChange={(v) => set({ filename: v })} />
          <Input label="Content type" value={u.contentType} placeholder="text/plain" onChange={(v) => set({ contentType: v })} />
        </Box>
        <Input label="Metadata" value={u.metadata} placeholder="{ owner: 'me' }" invalid={Boolean(u.error)} onChange={(v) => set({ metadata: v, error: undefined })} />
        {u.error ? <Text size="xs" tone="danger">{u.error}</Text> : null}
        <Text size="xs" muted>The content type is kept in metadata.contentType, as current drivers do.</Text>
        <Row gap="xs">
          <Button variant="solid" tone="accent" icon="upload" disabled={running} onPress={aguard(t.id, () => uploadFile(t.id))}>{running ? 'Uploading…' : 'Upload'}</Button>
        </Row>
        <JobProgress box={u.job?.state?.status === 'done' ? undefined : u.job} what="upload" onCancel={aguard(t.id, () => cancelGridJob(t.id, 'upload'))} />
      </Box>
    </Collapsible>
  )
}

export function GridfsTabView({ id }: { id: string }): OrcaNode {
  const t = read(adminTabs)[id]
  if (!t || t.kind !== 'gridfs') return null
  const files = t.files ?? []
  return (
    <Box gap="sm">
      <Row gap="xs" align="center" justify="between">
        <Box gap="none" grow>
          <Text weight="semibold" truncate>{`GridFS ${t.db}.${t.bucket}`}</Text>
          <Text size="xs" muted truncate>{connectionName(t.connectionId)}</Text>
        </Box>
        <IconButton icon="close" label={`Close the ${t.bucket} files`} variant="ghost" size="sm" onPress={() => closeAdmin(t.id)} />
      </Row>
      <Row gap="xs" align="end">
        <Box grow>
          <Input label="Name contains" type="search" value={t.filter} placeholder="invoice" onChange={(v) => changeAdmin(t.id, 'gridfs', () => ({ filter: v }))} onSubmit={() => void aguard(t.id, () => loadFiles(t.id))()} />
        </Box>
        <IconButton icon="refresh" label="Refresh the files" variant="ghost" onPress={aguard(t.id, () => loadFiles(t.id))} />
      </Row>
      <NoticeBar id={t.id} notice={t.notice} />
      {t.error ? <Callout tone="danger" icon="error" title="Could not list the files">{t.error}</Callout> : null}
      {!t.files && t.loading ? <Skeleton lines={5} label="Listing files" /> : null}
      {t.files ? (
        <Box gap="xs">
          <Table
            label="Files"
            columns={[
              { key: 'name', label: 'Name', minWidth: 'sm' },
              { key: 'size', label: 'Size', width: 'xs', align: 'end' },
              { key: 'at', label: 'Uploaded', width: 'sm', hideBelow: 'sm' },
              { key: 'type', label: 'Type', width: 'sm', hideBelow: 'md' }
            ]}
            rows={files.map((f) => ({ key: idKey(f.id), cells: { name: f.filename || '(no name)', size: bytesText(f.length), at: f.uploadDate ? { type: 'relative', at: f.uploadDate, format: 'short' } : '', type: f.contentType ?? '' } }))}
            selectionMode="single"
            selected={t.selected ? [t.selected] : []}
            hasMore={files.length < t.total}
            loading={t.loading}
            emptyText={t.filter ? 'No file names match.' : 'This bucket has no files.'}
            maxHeight="md"
            onLoadMore={() => void aguard(t.id, () => loadFiles(t.id, true))()}
            onSelectionChange={({ keys }) => void aguard(t.id, () => selectFile(t.id, keys[0]))()}
          />
          <Text size="xs" muted>{`${numberText(files.length)} of ${numberText(t.total)} file${t.total === 1 ? '' : 's'}`}</Text>
        </Box>
      ) : null}
      <Selected t={t} />
      {isReadOnly(t.connectionId) ? null : <Upload t={t} />}
    </Box>
  )
}

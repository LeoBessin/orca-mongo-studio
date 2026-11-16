// The editor's look, from Orca's theme variables only, so every Orca theme (light or dark)
// applies. Syntax colours mix the theme's own colours.
import { EditorView, HighlightStyle, syntaxHighlighting, tags as t, type Extension } from './vendor/codemirror.js'

export const PAGE_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--orca-background); color: var(--orca-foreground);
  font: 13px/1.4 system-ui, sans-serif;
}
button, select, input, textarea { font: inherit; color: inherit; }
.bar {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  padding: 6px 8px; border-bottom: 1px solid var(--orca-border); background: var(--orca-card);
}
.bar .grow { flex: 1; }
.bar label { display: inline-flex; align-items: center; gap: 4px; color: var(--orca-muted-foreground); font-size: 12px; }
.field {
  height: 26px; padding: 0 6px; border: 1px solid var(--orca-input); border-radius: var(--orca-radius);
  background: var(--orca-background); min-width: 0;
}
select.field { max-width: 200px; }
input.field { width: 140px; }
.field:focus-visible, .btn:focus-visible, textarea:focus-visible { outline: 2px solid var(--orca-ring); outline-offset: 1px; }
.btn {
  height: 26px; padding: 0 10px; border: 1px solid var(--orca-border); border-radius: var(--orca-radius);
  background: var(--orca-secondary); color: var(--orca-secondary-foreground); cursor: pointer; white-space: nowrap;
}
.btn:hover:not(:disabled) { background: var(--orca-accent); color: var(--orca-accent-foreground); }
.btn:disabled { opacity: .5; cursor: default; }
.btn.primary { background: var(--orca-primary); color: var(--orca-primary-foreground); border-color: transparent; }
.btn.primary:hover:not(:disabled) { background: var(--orca-primary); color: var(--orca-primary-foreground); filter: brightness(1.1); }
.btn.danger { color: var(--orca-destructive); }
.status { font-size: 12px; color: var(--orca-muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.status.error { color: var(--orca-destructive); }
#editor { flex: 1 1 60%; min-height: 80px; overflow: hidden; }
#editor .cm-editor { height: 100%; }
.splitter { height: 5px; cursor: row-resize; background: var(--orca-border); flex: none; }
.splitter:hover { background: var(--orca-ring); }
.pane { flex: 0 0 auto; height: 38%; min-height: 60px; display: flex; flex-direction: column; background: var(--orca-card); color: var(--orca-card-foreground); }
.tabs { display: flex; gap: 2px; padding: 4px 8px 0; border-bottom: 1px solid var(--orca-border); }
.tab {
  border: 0; background: none; padding: 4px 10px; cursor: pointer; color: var(--orca-muted-foreground);
  border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.tab[aria-selected="true"] { color: var(--orca-foreground); border-bottom-color: var(--orca-primary); }
.tabpanel { flex: 1; overflow: auto; padding: 8px; }
.tabpanel[hidden] { display: none; }
.mono, pre, textarea.sql { font-family: var(--ms-font, ui-monospace, monospace); font-size: var(--ms-font-size, 12px); }
pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
.entry { display: grid; grid-template-columns: 44px 1fr; gap: 6px; padding: 4px 0; border-bottom: 1px solid var(--orca-border); }
.entry:last-child { border-bottom: 0; }
.gutter { color: var(--orca-muted-foreground); font-size: 11px; text-align: right; padding-top: 1px; }
.gutter a { color: inherit; text-decoration: none; cursor: pointer; }
.gutter a:hover { color: var(--orca-foreground); text-decoration: underline; }
.summary { font-size: 12px; font-weight: 600; margin-bottom: 2px; }
.note { font-size: 12px; color: var(--orca-muted-foreground); margin-top: 2px; }
.entry.error pre { color: var(--orca-destructive); }
.entry.info pre { color: var(--orca-muted-foreground); font-style: italic; }
.runline { font-size: 12px; color: var(--orca-muted-foreground); padding-bottom: 4px; }
.empty { color: var(--orca-muted-foreground); font-size: 12px; padding: 4px 0; }
.row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 8px; }
.callout { border: 1px solid var(--orca-border); border-radius: var(--orca-radius); padding: 6px 8px; margin-bottom: 8px; font-size: 12px; }
.callout.error { border-color: var(--orca-destructive); color: var(--orca-destructive); }
.code { border: 1px solid var(--orca-border); border-radius: var(--orca-radius); padding: 8px; background: var(--orca-background); }
textarea.sql {
  width: 100%; min-height: 72px; resize: vertical; padding: 6px; border: 1px solid var(--orca-input);
  border-radius: var(--orca-radius); background: var(--orca-background);
}
ul.notes { margin: 6px 0 0; padding-left: 18px; font-size: 12px; color: var(--orca-muted-foreground); }
`

const mix = (a: string, pct: number, b = 'var(--orca-foreground)'): string => `color-mix(in srgb, ${a} ${pct}%, ${b})`

export function editorTheme(): Extension[] {
  const theme = EditorView.theme({
    '&': { color: 'var(--orca-foreground)', backgroundColor: 'var(--orca-background)', fontSize: 'var(--ms-font-size, 13px)' },
    '.cm-content': { fontFamily: 'var(--ms-font, ui-monospace, monospace)', caretColor: 'var(--orca-foreground)', lineHeight: 'var(--ms-line-height, 1.5)' },
    '.cm-scroller': { fontFamily: 'var(--ms-font, ui-monospace, monospace)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--orca-foreground)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: mix('var(--orca-primary)', 28, 'transparent')
    },
    '.cm-activeLine': { backgroundColor: mix('var(--orca-accent)', 45, 'transparent') },
    '.cm-gutters': { backgroundColor: 'var(--orca-background)', color: 'var(--orca-muted-foreground)', border: 'none' },
    '.cm-activeLineGutter': { backgroundColor: mix('var(--orca-accent)', 45, 'transparent'), color: 'var(--orca-foreground)' },
    '.cm-matchingBracket': { backgroundColor: mix('var(--orca-primary)', 25, 'transparent'), outline: '1px solid var(--orca-ring)' },
    '.cm-selectionMatch': { backgroundColor: mix('var(--orca-primary)', 15, 'transparent') },
    '.cm-tooltip': { backgroundColor: 'var(--orca-popover)', color: 'var(--orca-popover-foreground)', border: '1px solid var(--orca-border)', borderRadius: 'var(--orca-radius)' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--orca-accent)', color: 'var(--orca-accent-foreground)' },
    '.cm-completionDetail': { color: 'var(--orca-muted-foreground)', fontStyle: 'normal', marginLeft: '8px' },
    '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '600' },
    '.cm-panels': { backgroundColor: 'var(--orca-card)', color: 'var(--orca-card-foreground)' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--orca-border)' },
    '.cm-textfield': { backgroundColor: 'var(--orca-background)', border: '1px solid var(--orca-input)', borderRadius: 'var(--orca-radius)' },
    '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--orca-secondary)', color: 'var(--orca-secondary-foreground)', border: '1px solid var(--orca-border)', borderRadius: 'var(--orca-radius)' },
    '.cm-searchMatch': { backgroundColor: mix('var(--orca-primary)', 20, 'transparent') },
    '.cm-searchMatch-selected': { backgroundColor: mix('var(--orca-primary)', 40, 'transparent') },
    '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--orca-destructive)' },
    '.cm-diagnostic-error': { borderLeftColor: 'var(--orca-destructive)' },
    '.cm-foldPlaceholder': { backgroundColor: 'var(--orca-muted)', border: 'none', color: 'var(--orca-muted-foreground)' }
  })
  const highlight = HighlightStyle.define([
    { tag: [t.keyword, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: 'var(--orca-primary)', fontWeight: '600' },
    { tag: [t.string, t.special(t.string), t.regexp], color: mix('var(--orca-primary)', 55, 'var(--orca-destructive)') },
    { tag: [t.number, t.bool, t.null, t.atom], color: mix('var(--orca-destructive)', 70) },
    { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--orca-muted-foreground)', fontStyle: 'italic' },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: mix('var(--orca-primary)', 60) },
    { tag: [t.propertyName], color: mix('var(--orca-foreground)', 85, 'var(--orca-primary)') },
    { tag: [t.variableName, t.definition(t.variableName)], color: 'var(--orca-foreground)' },
    { tag: [t.punctuation, t.bracket, t.operator], color: mix('var(--orca-foreground)', 75, 'var(--orca-muted-foreground)') },
    { tag: t.invalid, color: 'var(--orca-destructive)' }
  ])
  return [theme, syntaxHighlighting(highlight)]
}

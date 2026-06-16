// Shared state, constants, and DOM handles for the webview UI.
// Imported by render.js, view.js, and main.js.

// The VS Code API handle — acquired exactly once for the whole webview.
export const vscode = acquireVsCodeApi();

// Frequently used DOM nodes (the document is already parsed when this module
// runs, since the entry script is a deferred module).
export const resultTitle = document.getElementById('result-title');
export const result = document.getElementById('result');
export const code = document.getElementById('code');

// Step titles shown above the result box.
export const titles = {
    source: 'Source code',
    invariants: 'Invariants',
    pbt: 'Property-based test cases',
    documentation: 'Documentation'
};

// Generate steps in order — each one enables the next page on success.
export const order = ['invariants', 'pbt', 'documentation'];

// Maps a step to its "Generate ..." button id.
export const generateIds = {
    invariants: 'generate-invariants',
    pbt: 'generate-pbt',
    documentation: 'generate-documentation'
};

// Generated content per step, so the first-row buttons can switch the view.
// Mutated in place (never reassigned), so it stays a const export.
export const contents = { source: '', invariants: '', pbt: '', documentation: '' };

// Mutable UI state, grouped in one object so other modules can both read and
// update it (a plain `let` export would be read-only to importers).
export const state = {
    current: 'invariants',   // which step's page is currently shown
    busy: false,             // true while a generation is in flight
    generatingBoth: false,   // true mid-run of the "Invariants and PBT" shortcut
    invariantChecked: []     // per-invariant checkbox state, parallel to the list
};

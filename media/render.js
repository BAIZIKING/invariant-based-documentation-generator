// Turns each step's result text into DOM, and reads the invariant selection.
// `marked` and `DOMPurify` are globals from the classic scripts loaded before
// the module entry point.
import { vscode, result, code, contents, state } from './state.js';
import { setBusy } from './view.js';

// Parse a JSON array of {invariant, lineno, end_lineno} and append one block
// per invariant (a checkbox plus the invariant text) to #result. Returns false
// if the text isn't a JSON array, so the caller can fall back to plain text.
export function renderInvariantList(obj) {
    if (!obj) {
        return false;
    }
    let items = obj.output;
    if (!Array.isArray(items)) {
        return false;
    }
    items.forEach((item, i) => {
        const block = document.createElement('div');
        block.className = 'invariant';

        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'invariant-check';
        // Default to checked; restore the saved state on later renders.
        check.checked = state.invariantChecked[i] !== undefined ? state.invariantChecked[i] : true;
        state.invariantChecked[i] = check.checked;
        check.addEventListener('change', () => { state.invariantChecked[i] = check.checked; });

        const body = document.createElement('span');
        body.className = 'invariant-text';
        body.textContent = (item && item.invariant) ? item.invariant : JSON.stringify(item);

        block.appendChild(check);
        block.appendChild(body);
        result.appendChild(block);
    });
    return true;
}

// Parse a JSON array of {invariant, explanation, test} and append one expandable
// entry per item: the invariant is the always-visible summary; the explanation
// and test function are revealed when expanded. Returns false if the text isn't
// a JSON array so the caller can fall back to text.
export function renderPbtList(obj) {
    if (!obj) {
        return false;
    }
    let items = obj.output;
    if (!Array.isArray(items)) {
        return false;
    }
    items.forEach((item, i) => {
        const entry = document.createElement('details');
        entry.className = 'pbt';

        const summary = document.createElement('summary');
        summary.className = 'pbt-summary';
        summary.textContent = (item && item.invariant) ? item.invariant : JSON.stringify(item);
        entry.appendChild(summary);

        if (item && item.explanation) {
            const explanation = document.createElement('div');
            explanation.className = 'pbt-explanation';
            explanation.textContent = item.explanation;
            entry.appendChild(explanation);
        }

        if (item && item.test) {
            const test = document.createElement('pre');
            test.className = 'pbt-test';
            test.textContent = item.test;
            entry.appendChild(test);

            // "Run test" button plus an output box beneath this test. Clicking
            // asks the extension to run the source + this test with Python and
            // post back a 'test-result' message keyed by this index.
            const run = document.createElement('button');
            run.type = 'button';
            run.className = 'pbt-run action';
            run.id = 'pbt-run-' + i;
            run.textContent = 'Run test';

            const output = document.createElement('pre');
            output.className = 'pbt-output';
            output.id = 'pbt-output-' + i;
            output.hidden = true;

            run.addEventListener('click', () => {
                if (state.busy) {
                    return;
                }
                setBusy(true);
                startTestRun(i, item.test);
            });

            // Restore any prior run state so it survives the re-render that
            // happens when the user switches pages and comes back.
            applyTestResult(run, output, state.testResults[i]);

            entry.appendChild(run);
            entry.appendChild(output);
        }

        result.appendChild(entry);
    });
    return true;
}

// Reflects a stored run result onto a test's run button and output box. Shared
// by the initial render (restoring saved state) and the live message handler.
function applyTestResult(run, output, stored) {
    if (!stored) {
        return;
    }
    if (stored.status === 'running') {
        run.disabled = true;
        output.hidden = false;
        output.className = 'pbt-output';
        output.textContent = 'Running...';
        return;
    }
    run.disabled = false;
    output.hidden = false;
    output.className = 'pbt-output ' + (stored.ok ? 'pbt-output-pass' : 'pbt-output-fail');
    output.textContent = stored.output;
}

// Kick off one test run: mark it pending, reflect "Running..." on its output box
// if that box is currently on screen, and ask the extension to run it. The caller
// takes the busy lock (setBusy(true)) before starting a batch; the lock is
// released in showTestResult once every pending run has returned.
function startTestRun(i, testCode) {
    state.pendingTests += 1;
    state.testResults[i] = { status: 'running' };
    const outEl = document.getElementById('pbt-output-' + i);
    if (outEl) {
        outEl.hidden = false;
        outEl.className = 'pbt-output';
        outEl.textContent = 'Running...';
    }
    vscode.postMessage({ type: 'run-test', id: i, code: code.value, test: testCode });
}

// Run every generated test (wired to the "Run all tests" button). Parses the
// stored PBT JSON — rather than reading the DOM — so it works regardless of how
// the page is currently rendered, and fires all runnable tests at once.
export function runAllTests() {
    if (state.busy) {
        return;
    }
    if (!contents.pbt) {
        return;
    }
    let items = contents.pbt.output;
    if (!Array.isArray(items)) {
        return;
    }
    const runnable = items
        .map((item, i) => ({ item, i }))
        .filter(({ item }) => item && item.test);
    if (runnable.length === 0) {
        return;
    }
    setBusy(true);
    for (const { item, i } of runnable) {
        startTestRun(i, item.test);
    }
}

// Called from the message handler when a 'test-result' arrives: store it (so a
// later re-render restores it) and update the matching button/output if the PBT
// page is currently showing those elements. Releases the busy lock once the last
// in-flight run has returned.
export function showTestResult(id, ok, output) {
    state.testResults[id] = { status: 'done', ok, output };
    const runEl = document.getElementById('pbt-run-' + id);
    const outEl = document.getElementById('pbt-output-' + id);
    if (runEl && outEl) {
        applyTestResult(runEl, outEl, state.testResults[id]);
    }
    state.pendingTests = Math.max(0, state.pendingTests - 1);
    if (state.pendingTests === 0) {
        setBusy(false);
    }
}

// The documentation step returns Markdown; render it to HTML with marked, then
// sanitize with DOMPurify before inserting it into a .markdown wrapper (whose
// styles are scoped so they don't touch the invariant/pbt blocks). DOMPurify
// strips dangerous markup; the CSP is the second layer that stops any script
// from executing even if something slipped through.
export function renderDocumentation(text) {
    const container = document.createElement('div');
    container.className = 'markdown';
    container.innerHTML = DOMPurify.sanitize(marked.parse(text || ''));
    result.appendChild(container);
    return true;
}

// The invariants JSON, keeping only the ones whose checkbox is ticked, so the
// PBT and documentation steps act on the user's selection rather than every
// generated invariant. Preserves the original {invariant, lineno, end_lineno}
// shape so the extension parses it the same way. Falls back to the raw text if
// it isn't a JSON array (e.g. a placeholder or error).
export function selectedInvariants() {
    if (!contents.invariants) {
        return contents.invariants;
    }
    let items = contents.invariants.output;
    if (!Array.isArray(items)) {
        return contents.invariants;
    }
    return JSON.stringify(items.filter((item, i) => state.invariantChecked[i]));
}

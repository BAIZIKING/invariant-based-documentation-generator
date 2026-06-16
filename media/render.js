// Turns each step's result text into DOM, and reads the invariant selection.
// `marked` and `DOMPurify` are globals from the classic scripts loaded before
// the module entry point.
import { result, contents, state } from './state.js';

// Parse a JSON array of {invariant, lineno, end_lineno} and append one block
// per invariant (a checkbox plus the invariant text) to #result. Returns false
// if the text isn't a JSON array, so the caller can fall back to plain text.
export function renderInvariantList(text) {
    let items;
    try {
        items = JSON.parse(text);
    } catch (e) {
        return false;
    }
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
export function renderPbtList(text) {
    let items;
    try {
        items = JSON.parse(text);
    } catch (e) {
        return false;
    }
    if (!Array.isArray(items)) {
        return false;
    }
    for (const item of items) {
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
        }

        result.appendChild(entry);
    }
    return true;
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
    let items;
    try {
        items = JSON.parse(contents.invariants);
    } catch (e) {
        return contents.invariants;
    }
    if (!Array.isArray(items)) {
        return contents.invariants;
    }
    return JSON.stringify(items.filter((item, i) => state.invariantChecked[i]));
}

const vscode = acquireVsCodeApi();
const resultTitle = document.getElementById('result-title');
const result = document.getElementById('result');
const code = document.getElementById('code');

const titles = {
    source: 'Source code',
    invariants: 'Invariants',
    pbt: 'Property-based test cases',
    documentation: 'Documentation'
};
// Generate steps in order — each one enables the next page on success.
const order = ['invariants', 'pbt', 'documentation'];
const generateIds = {
    invariants: 'generate-invariants',
    pbt: 'generate-pbt',
    documentation: 'generate-documentation'
};
// Generated content per step, so the first-row buttons can switch the view.
const contents = { source: '', invariants: '', pbt: '', documentation: '' };
let current = 'invariants'; // current step

// Show the current page's generate button, plus the next step's button
// once the current step has generated but the next one hasn't yet. Hide
// the rest, so a page never shows two buttons for already-generated steps.
function updateButtons() {
    const next = order[order.indexOf(current) + 1];
    for (const step of order) {
        const visible = step === current
            || (step === next && contents[current] !== '' && contents[next] === '');
        document.getElementById(generateIds[step]).hidden = !visible;
    }
}

// Shows the content for the step
function showStep(step) {
    current = step;
    resultTitle.textContent = titles[step];
    result.textContent = '';
    // Invariants and PBT return JSON arrays rendered as rich lists; any
    // non-JSON text (a placeholder or an error) falls back to plain text.
    let rendered = false;
    if (step === 'invariants') {
        rendered = renderInvariantList(contents[step]);
    } else if (step === 'pbt') {
        rendered = renderPbtList(contents[step]);
    } else if (step === 'documentation') {
        rendered = renderDocumentation(contents[step]);
    }
    if (!rendered) {
        result.textContent = contents[step];
    }
    updateButtons();
    updateFlow();
}

// Selection state for the invariant checkboxes, parallel to the rendered
// list. Reset when invariants are (re)generated; kept across page switches.
let invariantChecked = [];

// Parse a JSON array of {invariant, lineno, end_lineno} and append one
// block per invariant (a checkbox plus the invariant text) to #result.
// Returns false if the text isn't a JSON array, so the caller can fall
// back to showing it verbatim.
function renderInvariantList(text) {
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
        check.checked = invariantChecked[i] !== undefined ? invariantChecked[i] : true;
        invariantChecked[i] = check.checked;
        check.addEventListener('change', () => { invariantChecked[i] = check.checked; });

        const body = document.createElement('span');
        body.className = 'invariant-text';
        body.textContent = (item && item.invariant) ? item.invariant : JSON.stringify(item);

        block.appendChild(check);
        block.appendChild(body);
        result.appendChild(block);
    });
    return true;
}

// Parse a JSON array of {invariant, explanation, test} and append one
// expandable entry per item: the invariant is the always-visible summary;
// the explanation and test function are revealed when expanded. Returns
// false if the text isn't a JSON array so the caller can fall back to text.
function renderPbtList(text) {
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

// The documentation step returns Markdown; render it to HTML with marked,
// then sanitize with DOMPurify before inserting it into a .markdown wrapper
// (whose styles are scoped so they don't touch the invariant/pbt blocks).
// DOMPurify strips dangerous markup; the CSP is the second layer that stops
// any script from executing even if something slipped through.
function renderDocumentation(text) {
    const container = document.createElement('div');
    container.className = 'markdown';
    container.innerHTML = DOMPurify.sanitize(marked.parse(text || ''));
    result.appendChild(container);
    return true;
}

// Colour the first-row buttons by state: the current page (blue); a step
// whose content is generated, plus step 01 which is always done (green);
// a reachable step not yet generated (amber); else unreachable (grey).
function updateFlow() {
    for (const btn of document.querySelectorAll('#flow button')) {
        const step = btn.dataset.action;
        if (step === current) {
            btn.className = 'current';
        } else if (step === 'source' || contents[step] !== '') {
            btn.className = 'completed';
        } else if (!btn.disabled) {
            btn.className = 'reachable';
        } else {
            btn.className = 'unreachable';
        }
    }
}

// First row: switch which step's content (and generate button) is shown.
for (const btn of document.querySelectorAll('#flow button')) {
    btn.addEventListener('click', () => showStep(btn.dataset.action));
}

// The invariants JSON, keeping only the ones whose checkbox is ticked, so the
// PBT and documentation steps act on the user's selection rather than every
// generated invariant. Preserves the original {invariant, lineno, end_lineno}
// shape so the extension parses it the same way. Falls back to the raw text if
// it isn't a JSON array (e.g. a placeholder or error).
function selectedInvariants() {
    let items;
    try {
        items = JSON.parse(contents.invariants);
    } catch (e) {
        return contents.invariants;
    }
    if (!Array.isArray(items)) {
        return contents.invariants;
    }
    return JSON.stringify(items.filter((item, i) => invariantChecked[i]));
}

// Generate buttons: switch to the step's page, then ask the extension to
// run the matching backend function.
for (const step of order) {
    document.getElementById(generateIds[step]).addEventListener('click', () => {
        showStep(step);
        result.textContent = 'Generating...';
        vscode.postMessage({
            type: 'generate',
            step: step,
            code: code.value,
            invariants: selectedInvariants()
        });
    });
}

window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type !== 'result') {
        return;
    }
    if (!message.ok) {
        current = message.step;
        resultTitle.textContent = titles[message.step];
        result.textContent = message.text;
        updateButtons();
        return;
    }
    contents[message.step] = message.text;
    // Fresh invariants supersede any previous checkbox selection.
    if (message.step === 'invariants') {
        invariantChecked = [];
    }
    // Enable the next step's first-row page button.
    const next = order[order.indexOf(message.step) + 1];
    if (next) {
        document.querySelector('#flow button[data-action="' + next + '"]').disabled = false;
    }
    showStep(message.step);
    // The button that ran becomes "Regenerate ...".
    const ran = document.getElementById(generateIds[message.step]);
    ran.textContent = ran.textContent.replace(/^Generate /, 'Regenerate ');
});

updateButtons();
updateFlow();

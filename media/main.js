// Entry point: wires up the event listeners and runs the initial render.
// Loaded as a module; it pulls in state.js, render.js, and view.js.
import { vscode, resultTitle, result, code, titles, order, generateIds, contents, state } from './state.js';
import { selectedInvariants, showTestResult, runAllTests } from './render.js';
import { showStep, updateButtons, updateFlow, setBusy } from './view.js';

// First row: switch which step's content (and generate button) is shown.
for (const btn of document.querySelectorAll('#flow button')) {
    btn.addEventListener('click', () => showStep(btn.dataset.action));
}

// Generate buttons: switch to the step's page, then ask the extension to run
// the matching backend function. The busy lock serializes generation to one at
// a time, so spamming a button only triggers a single run.
for (const step of order) {
    document.getElementById(generateIds[step]).addEventListener('click', () => {
        if (state.busy) {
            return;
        }
        setBusy(true);
        console.log("Here! going to show step");
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

// Combined shortcut: generate invariants, then chain into PBT once they arrive
// (the chaining happens in the result handler when state.generatingBoth is set).
document.getElementById('generate-invariants-pbt').addEventListener('click', () => {
    if (state.busy) {
        return;
    }
    setBusy(true);
    state.generatingBoth = true;
    showStep('invariants');
    result.textContent = 'Generating...';
    vscode.postMessage({
        type: 'generate',
        step: 'invariants',
        code: code.value,
        invariants: contents.invariants
    });
});

// "Looks good, generate Documentation": jump straight to documentation using the
// checked invariants (skipping PBT). Enables the documentation flow button and
// switches to its view.
document.getElementById('approve-documentation').addEventListener('click', () => {
    if (state.busy) {
        return;
    }
    setBusy(true);
    document.querySelector('#flow button[data-action="documentation"]').disabled = false;
    showStep('documentation');
    result.textContent = 'Generating...';
    vscode.postMessage({
        type: 'generate',
        step: 'documentation',
        code: code.value,
        invariants: selectedInvariants()
    });
});

// "Run all tests": run every generated PBT test at once (gated by the busy lock,
// which runAllTests takes and releases as runs complete).
document.getElementById('run-all-tests').addEventListener('click', () => {
    runAllTests();
});

// "Download documentation": hand the generated Markdown to the extension, which
// opens a Save dialog and writes the file (the webview is sandboxed and can't).
document.getElementById('download-documentation').addEventListener('click', () => {
    if (state.busy || !contents.documentation) {
        return;
    }
    vscode.postMessage({ type: 'download', text: contents.documentation });
});

// view-raw should toggle viewRaw state, and rerender the page to view raw markdown
document.getElementById('view-raw').addEventListener('click', () => {
    state.viewRaw = !state.viewRaw;
    showStep('documentation');
});

// Results coming back from the extension.
window.addEventListener('message', (event) => {
    const message = event.data;
    console.log("message");
    console.log(JSON.stringify(event.data));
    // A finished property-based test run: update its button and output box.
    if (message.type === 'test-result') {
        showTestResult(message.id, message.ok, message.output);
        return;
    }
    if (message.type !== 'result') {
        return;
    }
    if (!message.ok) {
        state.generatingBoth = false; // a failure stops the combined run
        setBusy(false);
        state.current = message.step;
        resultTitle.textContent = titles[message.step];
        result.textContent = message.text;
        updateButtons();
        return;
    }
    contents[message.step] = message.text;
    // Fresh invariants supersede any previous checkbox selection.
    if (message.step === 'invariants') {
        state.invariantChecked = [];
    }
    // Freshly generated tests invalidate any previous run results.
    if (message.step === 'pbt') {
        state.testResults = {};
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

    // Combined shortcut: once invariants land, chain into PBT (using all the
    // freshly generated invariants); the lock stays held across the chain.
    if (state.generatingBoth && message.step === 'invariants') {
        showStep('pbt');
        result.textContent = 'Generating...';
        vscode.postMessage({
            type: 'generate',
            step: 'pbt',
            code: code.value,
            invariants: selectedInvariants()
        });
    } else {
        // Single generation finished, or the combined chain's PBT finished.
        state.generatingBoth = false;
        setBusy(false);
    }
});

// Initial paint.
updateButtons();
updateFlow();

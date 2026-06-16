// Entry point: wires up the event listeners and runs the initial render.
// Loaded as a module; it pulls in state.js, render.js, and view.js.
import { vscode, resultTitle, result, code, titles, order, generateIds, contents, state } from './state.js';
import { selectedInvariants } from './render.js';
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

// Results coming back from the extension.
window.addEventListener('message', (event) => {
    const message = event.data;
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

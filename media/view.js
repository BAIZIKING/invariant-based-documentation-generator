// View logic: which page is shown, which buttons are visible/enabled, and the
// colour of the first-row flow buttons.
import { state, contents, titles, order, generateIds, resultTitle, result } from './state.js';
import { renderInvariantList, renderPbtList, renderDocumentation } from './render.js';

// Render the content for a step and refresh the buttons + flow colours.
// Invariants and PBT return JSON arrays rendered as rich lists; documentation
// is Markdown; any non-JSON text (a placeholder or an error) falls back to
// plain text.
export function showStep(step) {
    state.current = step;
    resultTitle.textContent = titles[step];
    result.textContent = '';
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

// Show the current page's generate button, plus the next step's button once the
// current step has generated but the next one hasn't yet. Hide the rest, so a
// page never shows two buttons for already-generated steps.
export function updateButtons() {
    const next = order[order.indexOf(state.current) + 1];
    for (const step of order) {
        const visible = step === state.current
            || (step === next && contents[state.current] !== '' && contents[next] === '');
        document.getElementById(generateIds[step]).hidden = !visible;
    }
    // The combined shortcut only appears on the invariants page, and only while
    // neither invariants nor PBT has been generated yet.
    document.getElementById('generate-invariants-pbt').hidden =
        !(state.current === 'invariants' && contents.invariants === '' && contents.pbt === '');
}

// Colour the first-row buttons by state: the current page (blue); a step whose
// content is generated, plus step 01 which is always done (green); a reachable
// step not yet generated (amber); else unreachable (grey).
export function updateFlow() {
    for (const btn of document.querySelectorAll('#flow button')) {
        const step = btn.dataset.action;
        if (step === state.current) {
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

// Flip the busy lock and disable/enable every generate button to match, so only
// one generation runs at a time.
export function setBusy(value) {
    state.busy = value;
    document.getElementById('generate-invariants-pbt').disabled = value;
    for (const step of order) {
        document.getElementById(generateIds[step]).disabled = value;
    }
}

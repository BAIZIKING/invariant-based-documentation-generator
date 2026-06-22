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
        // Before docs exist, show the invariants (with checkboxes) as a
        // confirmation screen; once generated, render the Markdown.
        rendered = contents.documentation !== ''
            ? (state.viewRaw ? false : renderDocumentation(contents.documentation))
            : renderInvariantList(contents.invariants);
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
        let visible;
        if (step === 'documentation') {
            // Documentation's button is "Regenerate" — only on the documentation
            // page, and only once documentation has been generated.
            visible = state.current === 'documentation' && contents.documentation !== '';
        } else {
            visible = step === state.current
                || (step === next && contents[state.current] !== '' && contents[next] === '');
        }
        document.getElementById(generateIds[step]).hidden = !visible;
    }
    // The combined shortcut only appears on the invariants page, and only while
    // neither invariants nor PBT has been generated yet.
    document.getElementById('generate-invariants-pbt').hidden =
        !(state.current === 'invariants' && contents.invariants === '' && contents.pbt === '');

    // "Looks good, generate Documentation" shortcut: only while documentation
    // hasn't been generated yet, and either on the documentation page or on an
    // invariants/pbt page that already has content.
    const approveVisible = contents.documentation === ''
        && (state.current === 'documentation' || contents[state.current] !== '');
    document.getElementById('approve-documentation').hidden = !approveVisible;

    // "Run all tests" appears only on the PBT page, and only once tests exist.
    document.getElementById('run-all-tests').hidden =
        !(state.current === 'pbt' && contents.pbt !== '');

    // "Download documentation" appears only once documentation has been
    // generated — exactly when "approve-documentation" hides, so they share the
    // standalone slot below the result box.
    document.getElementById('download-documentation').hidden = contents.documentation === '' || state.current !== 'documentation';

    // same with view-raw
    document.getElementById('view-raw').hidden = contents.documentation === '' || state.current !== 'documentation';
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
    for (const button of document.getElementsByClassName('action')){
        button.disabled = value;
    }
}

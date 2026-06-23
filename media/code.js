// Renders the read-only source into #code-view (one element per line) and
// highlights line ranges when the user hovers an invariant. The source text
// itself lives in the disabled, hidden #code textarea, so the rest of the app
// keeps reading code.value unchanged.
import { code, codeView } from './state.js';

// Build the line elements once from the source. Each line carries its 1-based
// number in data-line, matching the lineno/end_lineno the model returns.
export function renderCode() {
    codeView.textContent = '';
    const lines = code.value.split('\n');
    lines.forEach((line, i) => {
        const el = document.createElement('div');
        el.className = 'code-line';
        el.dataset.line = String(i + 1);
        // Empty lines keep their height via the .code-line min-height in CSS.
        el.textContent = line;
        codeView.appendChild(el);
    });
}

// Highlight the inclusive 1-based line range [from, to], clearing any previous
// highlight first. No-ops unless both are integers (the model returns null line
// numbers when no specific line supports an invariant).
export function highlightLines(from, to) {
    clearHighlight();
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
        return;
    }
    for (let n = from; n <= to; n++) {
        const el = codeView.querySelector('.code-line[data-line="' + n + '"]');
        if (el) {
            el.classList.add('highlight');
        }
    }
}

// Remove every line highlight.
export function clearHighlight() {
    for (const el of codeView.querySelectorAll('.code-line.highlight')) {
        el.classList.remove('highlight');
    }
}
